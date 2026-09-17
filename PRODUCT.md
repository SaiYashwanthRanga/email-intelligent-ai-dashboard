# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Individual staff members at Horizon Family Medical Group (HFMG), a healthcare organization — each with their own login. Roles observed in the product's own folder structure include providers, RCM (revenue cycle management) staff, accounting, IT, and other named departments/individuals. Categorization, follow-up tracking, and settings are personal to each logged-in user, not shared team state.

## Product Purpose

JIM is an AI email dashboard that triages a high-volume healthcare-org inbox: it auto-categorizes and prioritizes incoming mail (VIP, urgent, meetings, newsletters, etc.) so staff can act on what matters without reading linearly, tracks sent mail for replies still owed (with automated reminders), surfaces today's calendar without leaving the inbox, and provides an AI assistant ("Iris") that answers questions grounded in the person's actual mail, sent history, tracking status, and calendar — rather than guessing.

## Positioning

The core differentiator is AI triage cutting through inbox volume: upfront categorization/prioritization surfaces what matters immediately in a mailbox too large to read start-to-finish, unlike a plain inbox client (Outlook) that shows mail in raw chronological order. It is purpose-built for one healthcare org's specific categories, staff roles, and compliance-conscious handling (e.g., a CONFIDENTIAL category, follow-up accountability) rather than being a generic AI-email add-on.

## Operating Context

Staff log in individually. Mail syncs from the org's Exchange/EWS-backed mail server (integration referred to internally as "ORG_BASE", via a .NET/EWS backend). Core workflows: triaging the inbox through fixed category and folder tabs; following up on sent mail awaiting a reply (Tracking); checking today's calendar without leaving the inbox; asking Iris questions about mail, sent history, tracking, or the calendar; and (newly, in progress) an Admin back-office for personal settings (compose/send behavior, with more sections planned).

## Capabilities and Constraints

**Frozen, non-negotiable (confirmed directly by the product owner):**
- The category classification system (CATEGORY_META) and its underlying AI classification logic in InboxView.jsx / services.py must never be modified.
- The VIP/Legal/Providers/priority list files (`*_list.json`) and folder-membership logic must never be modified.
- The folder-tab bar (ALL EMAILS / THREADS / GLOBAL / RCM_MGRS / RINKU / IT / SALLY / ACCOUNTING / OM_PROVIDERS) and the category-tab bar (ALL / NORMAL / VIP / LEGAL / PRIORITY / URGENT / CONFIDENTIAL / MEETING / ZOOM / NEWSLETTER) in InboxView.jsx must keep identical labels, counts, order, styling, and behavior. Not to be touched, refactored, or renamed even for an apparent improvement.
- All product changes must be purely additive — new UI, fields, or aggregation — never altering existing categorization, folder routing, or these tab bars.
- A separate, user-editable "Tags" system (distinct from the fixed categories above) is in scope for the Admin section, but it must never expose any way to edit the frozen categories/folders themselves.
- Iris (the AI assistant) must never perform an action on its own. Every action it prepares (send, forward, reply, mark-read, RSVP, start tracking) requires an explicit human confirmation via a proposal/confirm step before anything happens — a deliberate safety property, enforced structurally rather than by prompting.

**Process constraint:** this is a production application with live users at a healthcare org. Every change is treated as production-sensitive; work ships one phase at a time, confirmed working live before the next phase begins.

**Undecided / not yet built:** the Admin section's "Organize & filing" (AI-proposed mail filing) and "Tags" (user-authored semantic tagging with an AI classifier) are planned but not yet built, and their exact mechanics are still open — the one settled constraint is that neither may touch the frozen folder/category system above. "Signatures" (compose signatures) is also planned but not yet built.

## Brand Commitments

- Product name: **JIM**.
- Built for and branded to **Horizon Family Medical Group (HFMG)** — an existing organization with its own name and logo, already in use in the product header.
- The built-in AI assistant is named **Iris**.
- A separate reference product ("Hermes", with an assistant named "Atticus") was shown as UX/behavior inspiration for the Admin section's design — it is not JIM's own branding and should not be treated as evidence of JIM's identity.

## Evidence on Hand

- No testimonials, case studies, press, or user research artifacts exist yet.
- The real HFMG logo asset is in use in the product.
- Reference screenshots of a different product ("Hermes") were supplied as inspiration for specific Admin sub-features; treat them as a behavioral/UX reference only, never as JIM's own content or claims.

## Product Principles

1. **Additive-first.** New work sits alongside existing behavior; the frozen categorization, folder, and tab-bar systems are never modified, refactored, or "improved."
2. **Individual, not shared.** Every feature (inbox, tracking, settings) is scoped to the logged-in staff member's own view — not shared team state.
3. **AI proposes, humans decide.** Anything Iris (or any future automation) prepares that would change mail state or send something requires an explicit human confirmation first.
4. **Ship in reviewable phases.** Given production sensitivity in a healthcare setting, changes land one confirmed-working phase at a time rather than in large unreviewed batches.
5. **Grounded answers over guesses.** Iris is built to search and read real mail/tracking/calendar data rather than answer from an assumption or a stale summary.
