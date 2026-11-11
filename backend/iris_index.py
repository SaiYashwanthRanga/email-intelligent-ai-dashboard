"""
iris_index.py — meaning-based search for Iris
─────────────────────────────────────────────────────────────────────────
Keyword search only finds an email when the words of the question appear
in its subject, sender or one-line summary. This module adds the other
half: every analysed email is turned into an embedding vector built from
its FULL text (subject, sender, summary and the cached body), so a
question finds emails by topic even when they share no words with it —
"anything about staff leaving" finds "Resignation notice".

How it works
  • One small index per user under iris_index/<user>/ : vecs.npy (one row
    per email, unit length) + meta.json (which email each row is).
  • ensure_index() is incremental. It embeds only emails that are new or
    whose text has changed (e.g. the body was cached after the summary),
    and drops rows for emails no longer in the cache. Steady state is a
    handful of embeddings per sync; the first run for a 500-email inbox is
    a few batched calls.
  • semantic_search() embeds the question and ranks by cosine similarity.

Everything here is best-effort. If the embeddings service can't be
reached the functions return nothing and log it — Iris's keyword search
keeps working exactly as before.

Same data boundary as the rest of the app: the text sent for embedding is
the same email text already sent to the same AI provider for analysis.
"""

import os
import re
import json
import asyncio
import hashlib

import numpy as np

from services import (
    client,
    log,
    get_cached_emails_by_id,
    get_cached_detail,
    has_cached_detail,
)

EMBED_MODEL = os.getenv("IRIS_EMBED_MODEL", "text-embedding-3-small")
EMBED_DIM = 512               # shortened vectors: ~1 MB per 500 emails on disk
EMBED_BATCH = 64              # texts per embeddings request
EMBED_CONCURRENCY = 3
EMBED_TEXT_CHARS = 6000       # per email; enough for the substance of a long thread
INDEX_DIR = "iris_index"
# Below this cosine similarity a hit is noise rather than a match.
MIN_SIMILARITY = float(os.getenv("IRIS_MIN_SIMILARITY", "0.30"))

_locks: dict = {}             # user -> asyncio.Lock (one index build at a time)
_mem: dict = {}               # user -> loaded index
_query_cache: dict = {}       # query text -> vector (tiny, per process)
_QUERY_CACHE_MAX = 64


def _lock_for(user_email: str) -> asyncio.Lock:
    if user_email not in _locks:
        _locks[user_email] = asyncio.Lock()
    return _locks[user_email]


def _dir_for(user_email: str) -> str:
    safe = re.sub(r"[^\w@.-]", "_", (user_email or "default").lower().strip())
    return os.path.join(INDEX_DIR, safe)


def _empty_index() -> dict:
    return {"ids": [], "sigs": [], "vecs": np.zeros((0, EMBED_DIM), dtype=np.float32)}


def _load(user_email: str) -> dict:
    if user_email in _mem:
        return _mem[user_email]
    idx = _empty_index()
    directory = _dir_for(user_email)
    try:
        with open(os.path.join(directory, "meta.json"), "r", encoding="utf-8") as f:
            meta = json.load(f)
        vecs = np.load(os.path.join(directory, "vecs.npy"))
        # A different model or size means the stored vectors are not
        # comparable with new ones — start again rather than mix them.
        if (meta.get("model") == EMBED_MODEL and meta.get("dim") == EMBED_DIM
                and vecs.ndim == 2 and vecs.shape == (len(meta.get("ids") or []), EMBED_DIM)
                and len(meta.get("sigs") or []) == vecs.shape[0]):
            idx = {"ids": list(meta["ids"]), "sigs": list(meta["sigs"]), "vecs": vecs.astype(np.float32)}
    except FileNotFoundError:
        pass
    except Exception as e:
        log.warning(f"[iris-index] could not load index for {user_email}, rebuilding: {e}")
    _mem[user_email] = idx
    return idx


def _save(user_email: str, idx: dict):
    directory = _dir_for(user_email)
    os.makedirs(directory, exist_ok=True)
    # Write-then-rename, vectors first: a crash can't leave meta pointing at
    # rows that aren't there (a mismatch is detected on load and rebuilt).
    vec_path = os.path.join(directory, "vecs.npy")
    with open(vec_path + ".tmp", "wb") as f:
        np.save(f, idx["vecs"])
    os.replace(vec_path + ".tmp", vec_path)
    meta_path = os.path.join(directory, "meta.json")
    with open(meta_path + ".tmp", "w", encoding="utf-8") as f:
        json.dump({"model": EMBED_MODEL, "dim": EMBED_DIM, "ids": idx["ids"], "sigs": idx["sigs"]}, f)
    os.replace(meta_path + ".tmp", meta_path)


def _signature(entry: dict, has_body: bool) -> str:
    """Cheap change detector — no body is read to compute it."""
    raw = "|".join([
        str(entry.get("subject") or ""),
        str(entry.get("from") or entry.get("sender") or ""),
        str(entry.get("summary") or ""),
        "body" if has_body else "nobody",
    ])
    return hashlib.sha1(raw.encode("utf-8", "ignore")).hexdigest()


def _entry_text(user_email: str, eid: str, entry: dict, to_text) -> str:
    parts = [
        f"Subject: {entry.get('subject') or 'No Subject'}",
        f"From: {entry.get('from') or entry.get('sender') or 'Unknown'}",
    ]
    if entry.get("category"):
        parts.append(f"Category: {entry.get('category')}")
    if entry.get("summary"):
        parts.append(f"Summary: {entry.get('summary')}")
    detail = get_cached_detail(user_email, eid)
    if detail and detail.get("body"):
        try:
            parts.append(to_text(detail.get("body") or ""))
        except Exception:
            pass
    return "\n".join(parts)[:EMBED_TEXT_CHARS]


def _normalise(mat: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (mat / norms).astype(np.float32)


async def _embed(texts: list) -> np.ndarray:
    """Embed texts in batches. Raises if the service can't be reached."""
    sem = asyncio.Semaphore(EMBED_CONCURRENCY)

    async def one(batch):
        async with sem:
            resp = await client.embeddings.create(model=EMBED_MODEL, input=batch, dimensions=EMBED_DIM)
            return [d.embedding for d in resp.data]

    batches = [texts[i:i + EMBED_BATCH] for i in range(0, len(texts), EMBED_BATCH)]
    results = await asyncio.gather(*(one(b) for b in batches))
    rows = [vec for chunk in results for vec in chunk]
    return _normalise(np.asarray(rows, dtype=np.float32).reshape(len(rows), EMBED_DIM))


def _plan(user_email: str, idx: dict):
    """Work out which emails need (re)embedding. Blocking — run in a thread."""
    cached = get_cached_emails_by_id(user_email) or {}
    current = {}
    for key, entry in cached.items():
        if not isinstance(entry, dict) or entry.get("_threadRef"):
            continue
        eid = entry.get("id") or entry.get("messageId") or key
        if eid:
            current[eid] = entry
    known = dict(zip(idx["ids"], idx["sigs"]))
    todo = []
    for eid, entry in current.items():
        sig = _signature(entry, has_cached_detail(user_email, eid))
        if known.get(eid) != sig:
            todo.append((eid, entry, sig))
    return current, todo


async def ensure_index(user_email: str, to_text) -> dict:
    """
    Bring the user's index up to date. Returns {"indexed", "total", "added"}.
    Never raises: on failure the previous index stays in place.
    """
    async with _lock_for(user_email):
        idx = _load(user_email)
        try:
            current, todo = await asyncio.to_thread(_plan, user_email, idx)
            stale = [i for i, eid in enumerate(idx["ids"]) if eid not in current]
            if not todo and not stale:
                return {"indexed": len(idx["ids"]), "total": len(current), "added": 0}

            new_vecs = None
            if todo:
                texts = await asyncio.to_thread(
                    lambda: [_entry_text(user_email, eid, entry, to_text) for eid, entry, _ in todo]
                )
                new_vecs = await _embed(texts)

            # Rebuild: keep rows that are still valid, then add the new ones.
            replaced = {eid for eid, _, _ in todo}
            keep = [i for i, eid in enumerate(idx["ids"]) if eid in current and eid not in replaced]
            ids = [idx["ids"][i] for i in keep]
            sigs = [idx["sigs"][i] for i in keep]
            vecs = idx["vecs"][keep] if keep else np.zeros((0, EMBED_DIM), dtype=np.float32)
            if todo:
                ids += [eid for eid, _, _ in todo]
                sigs += [sig for _, _, sig in todo]
                vecs = np.vstack([vecs, new_vecs])

            fresh = {"ids": ids, "sigs": sigs, "vecs": vecs.astype(np.float32)}
            await asyncio.to_thread(_save, user_email, fresh)
            _mem[user_email] = fresh
            if todo:
                log.info(f"[iris-index] {user_email}: embedded {len(todo)} email(s), index now {len(ids)}")
            return {"indexed": len(ids), "total": len(current), "added": len(todo)}
        except Exception as e:
            log.warning(f"[iris-index] update failed for {user_email} ({type(e).__name__}): {e}")
            return {"indexed": len(idx["ids"]), "total": None, "added": 0, "error": type(e).__name__}


async def semantic_search(user_email: str, query: str, to_text, limit: int = 60) -> list:
    """
    [(messageId, similarity)] best first, for emails whose meaning is close
    to the query. Empty list when there is nothing relevant, or when the
    embeddings service can't be reached.
    """
    query = (query or "").strip()
    if not query:
        return []
    await ensure_index(user_email, to_text)
    idx = _load(user_email)
    if not idx["ids"]:
        return []
    try:
        qvec = _query_cache.get(query)
        if qvec is None:
            qvec = (await _embed([query]))[0]
            if len(_query_cache) >= _QUERY_CACHE_MAX:
                _query_cache.pop(next(iter(_query_cache)))
            _query_cache[query] = qvec
        scores = idx["vecs"] @ qvec
        order = np.argsort(-scores)[:limit]
        return [(idx["ids"][i], float(scores[i])) for i in order if scores[i] >= MIN_SIMILARITY]
    except Exception as e:
        log.warning(f"[iris-index] search failed for {user_email} ({type(e).__name__}): {e}")
        return []
