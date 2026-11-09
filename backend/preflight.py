"""
Pre-deploy checks for the email dashboard backend.

Run this before restarting the service. It verifies the things that are
invisible until they bite in production — a missing key, an ORG_BASE pointing
at the wrong mail server, an AI endpoint the network blocks — and it sends no
email and mutates no state.

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
           else f"api={main.ORG_BASE} services={services.ORG_BASE} — these must match")


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
               f"{type(e).__name__}: {str(e)[:90]}{hint}")


def main_cli():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true", help="skip network checks")
    args = ap.parse_args()

    check_config()
    if not args.quick:
        asyncio.run(check_org_server())
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
