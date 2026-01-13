# GitHub Copilot / Agent Guidance — email-dashboard

Summary
- This repo is a minimal email-intelligence demo. Frontend: Create React App at `email-dashboard/`. Backend: FastAPI at `backend/` with AI enrichment (OpenAI Async client).
- Runtime: set `OPENAI_API_KEY` in `.env` for backend and optionally `REACT_APP_API_URL` for frontend override.

Quick start
- Backend: python -m pip install -r backend/requirements.txt; run `uvicorn main:app --reload` or `python backend/main.py`.
- Frontend: cd `email-dashboard/`, run `npm install` and `npm start`.

Key patterns & files
- Backend caching: `backend/services.py` saves to `db_cache.json` keys `meta_last_processed_timestamp`, `meta_last_full_report`, `meta_last_enriched_emails`.
- VIP senders: update `backend/vip_list.json` to mark priority senders.
- API surface: `/api/fetch-inbox` (GET), `/api/analyze` (POST with `{ emails: [...] }` => `{ emails, report }`), `/api/reply` (POST => `{ reply }`).
- Dates: fields are inconsistent (`receivedDateTime`, `received_at`, `date`); use helpers in `main.py` and `Dashboard.js` when adding new parsing logic.

AI conventions
- Model: code uses `gpt-4o-mini` via `openai.AsyncOpenAI` in `services.py`.
- Prompts expect strict JSON outputs. System message often includes `"Output JSON only."` and uses `response_format={"type":"json_object"}`. Keep this format when modifying prompts.
- If prompt structure changes, add fallback behaviors in code — many functions catch exceptions and use simple text fallbacks.

Developer tips
- Frontend caches UI state in `localStorage` (`emailDashboardData`, `jimAuthSession`, `loggedInUser`) — clear it when debugging state issues.
- Check console logs from backend (informative prints indicate cache hits and prompt failures).
- Avoid committing `.env` or `backend/db_cache.json`. Use repository secrets for API keys.

If you'd like, I can also add a short example payload and expected response, or create a unit test for `split_reply_chain` and `group_emails_by_subject` to protect parsing changes. Ask which you'd prefer.