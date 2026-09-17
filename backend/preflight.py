"""
Pre-deploy checks for the email dashboard backend.

Run this before restarting the service. It verifies the things that are
invisible until they bite in production — a missing key, an ORG_BASE pointing
at the wrong mail server, an AI endpoint the network blocks — and it sends no
email and mutates no tracking state.

    python preflight.py            # checks config + connectivity
    python preflight.py --quick    # config only, no network calls

Exit code 0 = safe to deploy, 1 = something needs attention.
"""
import argparse
import asyncio
import os
import sys

CHECKS: list = []


def record(name: str, ok: bool, detail: str, fatal: bool = True):
    CHECKS.append({"name": name, "ok": ok, "detail": detail, "fatal": fatal})


def check_config():
    import services
    import main

    record("OpenAI key present", bool(services.api_key),
           "set in .env" if services.api_key else "OPENAI_API_KEY missing from .env")

    agree = services.ORG_BASE.rstrip("/") == main.ORG_BASE.rstrip("/")
    record("ORG_BASE agrees across modules", agree,
           services.ORG_BASE if agree
           else f"api={main.ORG_BASE} scheduler={services.ORG_BASE} — these must match")

    users = main._scheduler_targets()
    record("Scheduler has users", bool(users),
           f"{len(users)} user(s): {', '.join(users)}" if users
           else "tracking_access.json is empty — nothing will be scheduled",
           fatal=False)

    record("Reminder delivery", True,
           f"{'ARMED' if services.REMINDERS_ENABLED else 'PARKED (TRACKING_REMINDERS=off)'}, "
           f"cap {services.MAX_REMINDERS_PER_CYCLE}/cycle", fatal=False)


async def check_org_server():
    import httpx
    import services
    url = f"{services.ORG_BASE}/api/Values/sent7days"
    try:
        async with httpx.AsyncClient(timeout=20) as hc:
            r = await hc.get(url, params={"email": "preflight@invalid"})
        # Any HTTP response proves the server is up and routable. The probe
        # address is deliberately invalid, so a 4xx/5xx for it says nothing
        # about health — only a transport failure does.
        record("Mail server reachable", True,
               f"{services.ORG_BASE} -> HTTP {r.status_code} (probe address is intentionally invalid)")
    except Exception as e:
        record("Mail server reachable", False,
               f"{services.ORG_BASE} -> {type(e).__name__}: {str(e)[:120]}")


async def check_sent_mail():
    """
    The tracking classifier is only as good as its input: no sent items means
    no bodies to read and nothing reaches Needs Review. This is the endpoint
    the scheduler actually calls, so it fails here exactly as it fails there.
    """
    import services
    try:
        items = await services.fetch_sent_items_for_tracking("preflight-probe@invalid", count=1)
        # An invalid mailbox legitimately yields nothing; what matters is that
        # the call completed. A real mailbox is checked below.
        record("Sent-mail endpoint responds", True, "reachable", fatal=False)
    except Exception as e:
        record("Sent-mail endpoint responds", False, f"{type(e).__name__}: {str(e)[:100]}")

    import main
    users = main._scheduler_targets()
    if not users:
        return
    who = users[0]
    items = await services.fetch_sent_items_for_tracking(who, count=5)
    if items:
        with_body = sum(1 for i in items if (i.get("body") or "").strip())
        record("Sent mail readable", with_body > 0,
               f"{who}: {len(items)} item(s), {with_body} with a body"
               if with_body else
               f"{who}: {len(items)} item(s) but NO bodies — the AI cannot judge content")
    else:
        record("Sent mail readable", False,
               f"{who}: no sent items returned. The mail server logs "
               f"'graph.microsoft.com refused' when it cannot reach Microsoft "
               f"Graph — check that first; nothing will reach Needs Review "
               f"until this returns mail.")


async def check_ai():
    import services
    try:
        r = await services.client.chat.completions.create(
            model=services.ACTIVE_MODEL,
            messages=[{"role": "user", "content": "reply with: ok"}],
            max_completion_tokens=5,
        )
        record("AI reachable", True,
               f"{services.ACTIVE_MODEL} -> {(r.choices[0].message.content or '').strip()[:20]!r}")
    except Exception as e:
        cause = e.__cause__
        hint = ""
        if "ACCESS_DENIED" in str(cause) or "SSLError" in type(cause).__name__:
            hint = " — looks like a TLS-inspecting proxy blocking api.openai.com"
        record("AI reachable", False,
               f"{type(e).__name__}: {str(e)[:90]}{hint}. "
               f"Tracking defers decisions while this is down (nothing is mis-classified).")


def main_cli():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip network checks")
    args = ap.parse_args()

    check_config()
    if not args.quick:
        asyncio.run(check_org_server())
        asyncio.run(check_sent_mail())
        asyncio.run(check_ai())

    width = max(len(c["name"]) for c in CHECKS)
    print()
    for c in CHECKS:
        mark = "PASS" if c["ok"] else ("FAIL" if c["fatal"] else "WARN")
        print(f"  [{mark}] {c['name'].ljust(width)}  {c['detail']}")

    failed = [c for c in CHECKS if not c["ok"] and c["fatal"]]
    warned = [c for c in CHECKS if not c["ok"] and not c["fatal"]]
    print()
    if failed:
        print(f"  {len(failed)} blocking issue(s) — do not deploy until resolved.")
        return 1
    print(f"  All checks passed{f' ({len(warned)} warning(s))' if warned else ''}.")
    return 0


if __name__ == "__main__":
    sys.exit(main_cli())
