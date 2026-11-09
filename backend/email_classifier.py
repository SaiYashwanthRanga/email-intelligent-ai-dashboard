"""
Deterministic pre-classification for the email triage pipeline.

Why this exists
---------------
Category decisions used to be one substring check (`is_newsletter_body`) in
front of an LLM that only ever saw the first 800 characters of the body. That
fails in both directions: a trade newsletter that happens to mention
"DocuSign" or "HEDIS" anywhere in 60K characters was vetoed, while a Labcorp
patient-request alert with an unsubscribe footer was called a newsletter.

The approach here separates *evidence* from *decisions*:

    1. assess()   - turn an email into weighted signals, grouped into
                    independent evidence FAMILIES (bulk, transactional,
                    conversational, internal, attachment). Category-agnostic.
    2. detectors  - small functions, one per category, that read the families
                    and return a Verdict with a tier:
                        certain   skip the LLM, the evidence is conclusive
                        likely    ask the LLM, and tell it what we saw
                        unlikely  nothing worth mentioning
                        blocked   hard counter-evidence; the LLM may not
                                  assign this category either
    3. guard()    - clamps an LLM answer that contradicts hard evidence.

Adding a category later (RECEIPT, SECURITY_ALERT, ...) means writing one
detector and registering it; the existing detectors and their thresholds are
untouched, so one category cannot degrade another.

Stdlib only, no I/O, no network: importable and testable on its own.
"""
from __future__ import annotations

import html as _html
import re
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

# ── Configuration ───────────────────────────────────────────────────────────

# Mail from these domains is "us". Internal mail is almost never a mass
# mailing, so it needs list-level proof (a List-Unsubscribe header or a
# marketing-platform link) before it can be a newsletter.
INTERNAL_DOMAINS = ("hfmg.net",)

# Senders whose mail is operational no matter what the footer says: ACO and
# payer partners, and e-signature services (they all append unsubscribe links).
NEWSLETTER_NEVER_DOMAINS = (
    "stellarhealth.com", "stellar.com", "guideprogram.com",
    "molinahealthcare.com", "molina.com",
    "xenterdiagnostics.com", "xenter.com",
    "docusign.com", "docusign.net",
    "hellosign.com", "signnow.com",
    "esignlive.com", "adobesign.com", "echosign.com",
    "dropboxsign.com",
)

# Imperative phrases: "this message IS the business request". These block a
# newsletter verdict when they appear in the subject or the opening of the
# message. Deeper in the body they are just words in an article.
TRANSACTIONAL_ACTION_PHRASES = (
    "please sign", "signature required", "sign the document", "review and sign",
    "completed document", "annual payment", "invoice attached",
    "payment attached", "agreement attached", "contract attached",
    "see attached", "please find attached", "attached for your review",
)
# Business-domain TOPIC terms. A bare topic word is not a request: a trade
# newsletter can lead with a headline about DocuSign or HEDIS. So these block
# only from the subject line; in the opening they merely stop the email being
# auto-filed (it goes to the LLM, with this noted as evidence).
TRANSACTIONAL_TOPIC_TERMS = (
    "docusign", "hedis", "chart chase", "chart retrieval", "aco partner",
    "guide program", "office hours program", "office hours call",
    "join our office hours",
)
TRANSACTIONAL_SIGNALS = TRANSACTIONAL_ACTION_PHRASES + TRANSACTIONAL_TOPIC_TERMS

# Automated, but about the recipient's own account/patient/order - not a
# newsletter even when a bulk platform sent it.
_NOTIFICATION_RE = re.compile(
    r"verification code|security code|one[- ]time (?:code|passcode|password)|"
    r"password reset|reset your password|sign[- ]?in (?:code|attempt)|"
    r"code for signing in|"
    r"order (?:confirmation|#|number)|your order|has shipped|out for delivery|"
    r"upcoming delivery|your (?:shipment|package|delivery)|tracking number|"
    r"\breceipt\b|\binvoice\b|payment (?:received|due|failed|confirmation)|"
    r"statement (?:is )?(?:ready|available)|account statement|"
    r"appointment (?:reminder|confirmation)|"
    r"has joined your meeting|recording (?:has )?(?:expired|is ready)|"
    r"you have (?:\d+ |an? )?(?:active |pending |new |open |unread )?"
    r"(?:requests?|tasks?|messages?|results?|alerts?|items?)\b|"
    r"action required|requires your (?:attention|action|approval)|"
    r"awaiting your|security alert|suspicious (?:activity|sign)|"
    r"message from your (?:doctor|provider|physician)",
    re.I,
)

# Marketing/newsletter infrastructure seen in tracked links. Hitting one of
# these in a message body is near-conclusive: people don't hand-write
# list-manage.com links.
_MARKETING_ESP_HOSTS = (
    "list-manage.com", "mailchi.mp", "mcusercontent.com", "mcsv.net",
    "constantcontact.com", "ctctcdn.com", "rs6.net", "ccsend.com",
    "hubspotemail.net", "hubspotlinks.com", "hs-sites.com", "hubspot.com",
    "mktoresp.com", "mkto-", "marketo.com", "pardot.com", "exct.net",
    "klaviyo.com", "klclick", "customeriomail.com", "customer.io",
    "convertkit", "ck.page", "kit.com", "beehiiv.com", "substack.com",
    "createsend.com", "cmail", "campaign-archive.com", "omeclk.com",
    "sendinblue.com", "brevo.com", "mailerlite.com", "mlsend.com",
    "acemlnk.com", "activehosted.com", "e2ma.net", "vresp.com",
    "emltrk.com", "iterable.com", "braze.com", "sailthru.com",
)
# Used by transactional mail too, so only a weak hint on their own.
_INFRA_LINK_HOSTS = (
    "sendgrid.net", "mandrillapp.com", "mailgun.org", "sparkpostmail.com",
    "awstrack.me", "amazonses.com", "postmarkapp.com",
)
# Sender domains that only ever mail newsletters.
_NEWSLETTER_PLATFORM_SENDERS = (
    "substack.com", "beehiiv.com", "buttondown.email", "ghost.io",
    "convertkit.com", "kit.com", "mailchimp.com", "campaign-archive.com",
    "constantcontact.com", "hubspotemail.net", "createsend.com",
)

_MARKETING_LOCAL_RE = re.compile(
    r"(?:^|[._+-])(news|newsletters?|editors?|editorial|digests?|marketing|"
    r"promo|promos|promotions?|offers?|deals?|mailer|campaigns?|"
    r"announcements?|webinars?|whitepapers?|events|resources|partners|"
    r"crew|briefing|subscriptions?)(?:$|[._+-])", re.I)
_WEAK_LOCAL = {"hello", "hi", "info", "team", "updates", "alerts", "email", "mail"}
_MARKETING_HOST_TOKENS = {
    "news", "newsletter", "newsletters", "e", "em", "eg", "email", "emails",
    "go", "mailer", "send", "sg", "mg", "marketing", "promo", "promotion",
    "promotions", "offers", "campaigns", "engage", "mktg", "lists", "members",
}

_MAX_SCAN_CHARS = 400_000     # newsletters run 60K+; bound pathological bodies
_LEAD_CHARS = 1500            # "the opening" of a message, for intent phrases
_DOC_EXTENSIONS = (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".ppt",
                   ".pptx", ".zip", ".txt", ".rtf", ".xml", ".ics")

# ── Regexes ─────────────────────────────────────────────────────────────────

_ANCHOR_RE = re.compile(r"<a\b([^>]*)>(.{0,300}?)</a\s*>", re.I | re.S)
_HREF_RE = re.compile(r"""href\s*=\s*(?:"([^"]*)"|'([^']*)')""", re.I)
_BARE_URL_RE = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
_IMG_RE = re.compile(r"<img\b", re.I)
_STYLE_SCRIPT_RE = re.compile(r"<(style|script)\b[^>]*>.*?</\1\s*>", re.I | re.S)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")

_UNSUB_RE = re.compile(
    r"unsubscribe|opt[\s_-]?out|(?:email|subscription|communication)[\s_-]?"
    r"preferences?|manage[\s_-]?(?:your[\s_-]?)?(?:email[\s_-]?)?"
    r"(?:preferences?|subscriptions?)|update[\s_-]?(?:your[\s_-]?)?"
    r"(?:email[\s_-]?)?preferences?", re.I)
_UNSUB_TEXT_RE = re.compile(r"unsubscribe|manage (?:your )?(?:email )?preferences", re.I)
_VIEW_BROWSER_RE = re.compile(
    r"view (?:this )?(?:email )?(?:in|on) (?:your |a |the )?(?:web )?browser|"
    r"(?:view|read) (?:it |this )?online|(?:view|read) (?:in|on) (?:the )?web|"
    r"trouble viewing|web version|view this email", re.I)
_SUB_FOOTER_RE = re.compile(
    r"you(?:'|’)?re receiving this|you are receiving this|"
    r"you received this (?:email|message)|you(?:'|’)?re (?:subscribed|on our)|"
    r"you (?:signed up|subscribed|opted in)|sent to you because|"
    r"this (?:email|message) was sent to|to stop receiving|"
    r"no longer wish to receive|don(?:'|’)?t want to receive|"
    r"change your (?:email )?(?:settings|preferences)", re.I)
_CTA_FAMILIES = {
    "forward": re.compile(
        r"forward(?:ed)? (?:this )?(?:email|message|newsletter)?\s?to a friend|"
        r"forwarded (?:this )?to you|share this (?:email|newsletter)", re.I),
    "referral": re.compile(
        r"referral|refer (?:a )?(?:friend|colleague|\d+)|your (?:unique |personal )?"
        r"(?:referral )?link", re.I),
    "subscribe": re.compile(
        r"subscribe (?:to|here|now|today)|sign up (?:here|for|to|today)|"
        r"join (?:the |our )?(?:newsletter|list)|in your inbox", re.I),
    "sponsor": re.compile(
        r"advertisement|sponsored|sponsors?\b|presented by|brought to you by|"
        r"in partnership with|partner content|advertise (?:with|in)", re.I),
}
_SUBJ_DIGEST_RE = re.compile(
    r"\b(newsletter|digest|daily|weekly|monthly|roundup|round-up|briefing|"
    r"brief|bulletin|edition|issue\s*#?\d+|top stories|what(?:'|’)s new|"
    r"this week in|recap)\b", re.I)
_SUBJ_DATE_LEAD_RE = re.compile(
    r"^\W*\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\W|^\s*\|\s*\d{1,2}[./-]\d{1,2}", re.I)
_SUBJ_PROMO_RE = re.compile(
    r"\d{1,3}\s?% off|save \$?\d+|\bsale\b|limited[- ]time|early[- ]bird|"
    r"free (?:trial|shipping|webinar|ebook|guide|demo)|last chance|"
    r"exclusive offer|register (?:now|today)|\bwebinar\b|white ?paper|"
    r"\be-?book\b|don(?:'|’)t miss|ends (?:today|tonight|soon)|new arrivals|"
    r"\bdeals?\b|join us", re.I)
_REPLY_SUBJ_RE = re.compile(r"^\s*(?:re|fw|fwd)\s*:", re.I)
_QUOTED_CHAIN_RE = re.compile(
    r"-{2,}\s*original message\s*-{2,}|^\s*on .{10,120} wrote:\s*$|"
    r"from:.{0,200}?sent:.{0,200}?to:.{0,200}?subject:|<blockquote\b",
    re.I | re.S | re.M)
_GREETING_RE = re.compile(r"^\s*(?:hi|hello|hey|dear)\s+[A-Z][\w'’-]{1,20}\s*[,:!]")
_DIRECT_ASK_RE = re.compile(
    r"\b(?:can|could|would) you\b|let me know|please (?:confirm|review|send|"
    r"reply|respond|advise)|your thoughts|get back to me|following up", re.I)


# ── Data model ──────────────────────────────────────────────────────────────

Signal = Tuple[str, float]   # (human-readable name, weight)

FAMILIES = ("bulk", "transactional", "conversational", "internal", "attachment")


@dataclass
class Assessment:
    """Everything we learned about one email, grouped by evidence family."""
    signals: Dict[str, List[Signal]] = field(
        default_factory=lambda: {f: [] for f in FAMILIES})
    blockers: List[str] = field(default_factory=list)   # hard "never" reasons
    cautions: List[str] = field(default_factory=list)   # "ask the LLM", not "never"
    strong_bulk: bool = False   # list header / marketing platform / unsub link
    list_proof: bool = False    # List-Unsubscribe header or marketing platform

    def add(self, family: str, name: str, weight: float) -> None:
        self.signals[family].append((name, weight))

    def score(self, family: str) -> float:
        return sum(w for _, w in self.signals[family])

    @property
    def bulk(self) -> float:
        return self.score("bulk")

    @property
    def counter(self) -> float:
        """Total evidence AGAINST a mass mailing (a positive number)."""
        return -sum(self.score(f) for f in FAMILIES if f != "bulk")

    @property
    def net(self) -> float:
        return self.bulk - self.counter


@dataclass(frozen=True)
class Verdict:
    category: str
    tier: str                      # certain | likely | unlikely | blocked
    score: float
    reasons: Tuple[str, ...] = ()
    blockers: Tuple[str, ...] = ()


@dataclass
class Decision:
    assessment: Assessment
    verdicts: Dict[str, Verdict]

    @property
    def certain(self) -> Optional[str]:
        """First registered category whose detector is conclusive, if any."""
        for cat, v in self.verdicts.items():
            if v.tier == "certain":
                return cat
        return None

    def tier(self, category: str) -> str:
        v = self.verdicts.get(category)
        return v.tier if v else "unlikely"


# ── Helpers ─────────────────────────────────────────────────────────────────

def _sender_address(sender: str) -> str:
    m = re.search(r"[\w.+'-]+@[\w.-]+", sender or "")
    return m.group(0).lower() if m else ""


def _registrable(host: str) -> str:
    parts = [p for p in (host or "").lower().split(".") if p]
    if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net", "gov", "ac"} and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def _domain_matches(domain: str, candidates: Tuple[str, ...]) -> bool:
    return any(domain == c or domain.endswith("." + c) for c in candidates)


def visible_text(body: str) -> str:
    """HTML -> whitespace-collapsed text. Whole body; callers slice."""
    text = _STYLE_SCRIPT_RE.sub(" ", body)
    text = _TAG_RE.sub(" ", text)
    text = _html.unescape(text)
    return _WS_RE.sub(" ", text).strip()


def _normalise_headers(headers) -> Dict[str, str]:
    """Accept {name: value} or [{name/value}] (EWS style); lower-case names."""
    out: Dict[str, str] = {}
    if isinstance(headers, dict):
        items = headers.items()
    elif isinstance(headers, list):
        items = (
            (h.get("name") or h.get("Name") or "", h.get("value") or h.get("Value") or "")
            for h in headers if isinstance(h, dict)
        )
    else:
        return out
    for k, v in items:
        if k:
            out[str(k).strip().lower()] = str(v)
    return out


def _extract_links(body: str) -> Tuple[List[str], List[Tuple[str, str]]]:
    """Return (all http(s) hrefs, [(href, anchor_text)])."""
    anchors: List[Tuple[str, str]] = []
    for m in _ANCHOR_RE.finditer(body):
        hm = _HREF_RE.search(m.group(1))
        if hm:
            anchors.append((hm.group(1) or hm.group(2) or "", _TAG_RE.sub(" ", m.group(2))))
    links = [h for h, _ in anchors if h.lower().startswith(("http://", "https://"))]
    if not anchors:                      # plain-text email: bare URLs
        links = _BARE_URL_RE.findall(body)
        anchors = [(u, "") for u in links]
    return links, anchors


# ── Evidence extraction ─────────────────────────────────────────────────────

def assess(
    subject: str = "",
    sender: str = "",
    body: str = "",
    attachments: Optional[list] = None,
    headers=None,
) -> Assessment:
    """Score one email. Pure function; safe to call on every sync."""
    a = Assessment()
    subject = subject or ""
    body = (body or "")[:_MAX_SCAN_CHARS]
    attachments = attachments or []
    hdr = _normalise_headers(headers)

    addr = _sender_address(sender)
    local, _, domain = addr.partition("@")
    text = visible_text(body)
    lead = text[:_LEAD_CHARS].lower()
    subj_lower = subject.lower()
    intent_zone = subj_lower + " " + lead      # where intent phrases count
    rest = text[_LEAD_CHARS:].lower()
    links, anchors = _extract_links(body)

    # ---- hard blockers ----------------------------------------------------
    if domain and _domain_matches(domain, NEWSLETTER_NEVER_DOMAINS):
        a.blockers.append(f"protected partner/e-sign domain ({domain})")

    # ---- bulk: mailing-list headers (best evidence, when the server sends them)
    if "list-unsubscribe" in hdr:
        a.add("bulk", "List-Unsubscribe header", 5.0)
        a.strong_bulk = a.list_proof = True
    if "list-id" in hdr:
        a.add("bulk", "List-Id header", 3.0)
        a.strong_bulk = a.list_proof = True
    if hdr.get("precedence", "").strip().lower() in ("bulk", "list", "junk"):
        a.add("bulk", "Precedence: bulk/list", 3.0)
        a.strong_bulk = True
    if any(k.startswith(("x-mailchimp", "x-campaign", "x-mc-", "x-sg-eid", "x-mandrill"))
           or k in ("feedback-id", "x-csa-complaints") for k in hdr):
        a.add("bulk", "marketing-platform header", 2.0)
        a.list_proof = True
    if hdr.get("auto-submitted", "").strip().lower() not in ("", "no"):
        a.add("transactional", "Auto-Submitted header", -1.0)

    # ---- bulk: unsubscribe / preference-centre ---------------------------
    unsub_anchor = any(_UNSUB_RE.search(h + " " + t) for h, t in anchors)
    if unsub_anchor:
        a.add("bulk", "unsubscribe/preferences link", 3.0)
        a.strong_bulk = True
    elif _UNSUB_TEXT_RE.search(text):
        a.add("bulk", "unsubscribe mentioned in text", 1.5)

    # ---- bulk: marketing infrastructure in links ---------------------------
    hosts = []
    for u in links:
        try:
            h = (urlsplit(u).hostname or "").lower()
        except ValueError:
            h = ""
        if h:
            hosts.append(h)
    if any(any(esp in h for esp in _MARKETING_ESP_HOSTS) for h in hosts):
        a.add("bulk", "marketing-platform tracked links", 3.0)
        a.strong_bulk = a.list_proof = True
    elif any(any(infra in h for infra in _INFRA_LINK_HOSTS) for h in hosts):
        a.add("bulk", "bulk-mail infrastructure links", 1.0)
    if len(hosts) >= 8:
        top_host, top_n = max(((h, hosts.count(h)) for h in set(hosts)), key=lambda x: x[1])
        same_org = _registrable(top_host) == _registrable(domain)
        if top_n / len(hosts) >= 0.6 and not same_org:
            a.add("bulk", "link wall through a third-party tracker", 2.0)
    if len(hosts) >= 30:
        a.add("bulk", f"{len(hosts)} links", 2.0)
    elif len(hosts) >= 15:
        a.add("bulk", f"{len(hosts)} links", 1.0)
    if len(_IMG_RE.findall(body)) >= 6:
        a.add("bulk", "image-heavy layout", 1.0)

    # ---- bulk: newsletter furniture --------------------------------------
    if _VIEW_BROWSER_RE.search(text):
        a.add("bulk", "view-in-browser link", 2.0)
    if _SUB_FOOTER_RE.search(text):
        a.add("bulk", "subscription footer wording", 2.0)
    cta = [name for name, rx in _CTA_FAMILIES.items() if rx.search(text)]
    if cta:
        a.add("bulk", "newsletter furniture (" + ", ".join(cta) + ")",
              min(3.0, 1.5 * len(cta)))
    if re.search(r"©|&copy;|\ball rights reserved\b", text, re.I):
        a.add("bulk", "copyright footer", 0.5)

    # ---- bulk: sender and subject shape ----------------------------------
    if domain and _domain_matches(domain, _NEWSLETTER_PLATFORM_SENDERS):
        a.add("bulk", "newsletter-platform sender", 3.0)
        a.strong_bulk = True
    if _MARKETING_LOCAL_RE.search(local):
        a.add("bulk", f"marketing-style sender name ({local})", 1.5)
    elif local in _WEAK_LOCAL:
        a.add("bulk", f"generic sender name ({local})", 0.5)
    host_prefix = domain.split(".")[:-2] if domain else []
    tokens = {t for lbl in host_prefix for t in re.split(r"[-_]", lbl)}
    if tokens & _MARKETING_HOST_TOKENS:
        a.add("bulk", f"marketing-style sender subdomain ({domain})", 1.0)
    if _SUBJ_DATE_LEAD_RE.search(subject) or _SUBJ_DIGEST_RE.search(subject):
        a.add("bulk", "digest/issue-style subject", 1.0)
    if _SUBJ_PROMO_RE.search(subject):
        a.add("bulk", "promotional subject", 1.0)

    # ---- transactional: this message IS the business request --------------
    action_up_front = [p for p in TRANSACTIONAL_ACTION_PHRASES if p in intent_zone]
    topic_in_subject = [t for t in TRANSACTIONAL_TOPIC_TERMS if t in subj_lower]
    topic_in_lead = [t for t in TRANSACTIONAL_TOPIC_TERMS if t in lead and t not in topic_in_subject]
    if action_up_front or topic_in_subject:
        hit = (action_up_front or topic_in_subject)[0]
        a.add("transactional", f"business-action wording up front ({hit})", -6.0)
        a.blockers.append(f"business-action wording in subject/opening ({hit})")
    if topic_in_lead:
        a.add("transactional", f"business terms in the opening ({', '.join(topic_in_lead[:3])})", -2.0)
        a.cautions.append(f"business terms in the opening ({topic_in_lead[0]})")
    already = set(action_up_front) | set(topic_in_subject) | set(topic_in_lead)
    deep = [t for t in TRANSACTIONAL_SIGNALS if t in rest and t not in already]
    if deep:
        # Only mentioned deep in the body: article text, not the request.
        a.add("transactional", f"business terms deeper in body ({', '.join(deep[:3])})",
              max(-1.5, -0.5 * len(deep)))
    nm = _NOTIFICATION_RE.search(subj_lower + " " + lead)
    if nm:
        a.add("transactional", f"account/patient notification wording ({nm.group(0).strip()})", -3.0)

    # ---- conversational ---------------------------------------------------
    if _REPLY_SUBJ_RE.search(subject):
        a.add("conversational", "Re:/Fwd: subject", -3.0)
    if _QUOTED_CHAIN_RE.search(body):
        a.add("conversational", "quoted reply chain", -3.0)
    if _GREETING_RE.search(text[:200]):
        a.add("conversational", "personal greeting", -1.0)
    if _DIRECT_ASK_RE.search(lead):
        a.add("conversational", "direct request to the reader", -1.5)

    # ---- internal ---------------------------------------------------------
    if domain and _domain_matches(domain, INTERNAL_DOMAINS):
        a.add("internal", "internal sender", -3.0)
        if not a.list_proof:
            a.blockers.append("internal sender without mailing-list proof")

    # ---- attachments ------------------------------------------------------
    doc_atts = []
    for att in attachments:
        name = str((att or {}).get("name") or "").lower()
        ctype = str((att or {}).get("type") or "").lower()
        if name.endswith(".ics") or "calendar" in ctype:
            a.blockers.append("calendar invite attached")
        if name.endswith(_DOC_EXTENSIONS) or (ctype and not ctype.startswith(("image/", "application/octet"))):
            doc_atts.append(name or ctype)
    if doc_atts:
        a.add("attachment", f"document attachment ({doc_atts[0]})", -4.0)
        if len(doc_atts) >= 2:
            a.blockers.append("multiple document attachments")

    if a.counter >= 6.0 and a.score("conversational") <= -6.0:
        a.blockers.append("reply thread")
    return a


# ── Detector registry ───────────────────────────────────────────────────────

Detector = Callable[[Assessment], Verdict]
_DETECTORS: Dict[str, Detector] = {}


def register_detector(category: str):
    """Register a detector for `category`. Order of registration = precedence."""
    def deco(fn: Detector) -> Detector:
        _DETECTORS[category] = fn
        return fn
    return deco


def registered_categories() -> Tuple[str, ...]:
    return tuple(_DETECTORS)


# Tunables for NEWSLETTER. Chosen against the real inbox in the test/eval
# suite: raising CERTAIN trades recall for precision; "likely" only affects
# the hint given to the LLM, so it is cheap to tune.
NEWSLETTER_CERTAIN_BULK = 6.0
NEWSLETTER_CERTAIN_NET = 5.0
NEWSLETTER_LIKELY_BULK = 3.5
NEWSLETTER_LIKELY_NET = 2.0


@register_detector("NEWSLETTER")
def _newsletter(a: Assessment) -> Verdict:
    reasons = tuple(f"{n} ({w:+g})" for n, w in
                    sorted(a.signals["bulk"], key=lambda s: -abs(s[1])))
    against = tuple(f"{n} ({w:+g})" for f in FAMILIES if f != "bulk"
                    for n, w in a.signals[f])
    if a.blockers:
        return Verdict("NEWSLETTER", "blocked", a.net, reasons + against, tuple(a.blockers))
    if (a.bulk >= NEWSLETTER_CERTAIN_BULK and a.net >= NEWSLETTER_CERTAIN_NET
            and a.strong_bulk and not a.cautions):
        return Verdict("NEWSLETTER", "certain", a.net, reasons, ())
    if a.bulk >= NEWSLETTER_LIKELY_BULK and a.net >= NEWSLETTER_LIKELY_NET:
        return Verdict("NEWSLETTER", "likely", a.net, reasons + against, tuple(a.cautions))
    return Verdict("NEWSLETTER", "unlikely", a.net, reasons + against, ())


# ── Public API ──────────────────────────────────────────────────────────────

def decide(email: dict) -> Decision:
    """Run every registered detector over an email dict from the pipeline."""
    a = assess(
        subject=email.get("subject") or "",
        sender=email.get("from") or email.get("sender") or "",
        body=str(email.get("body") or ""),
        attachments=email.get("attachments") or [],
        headers=email.get("headers"),
    )
    return Decision(a, {cat: det(a) for cat, det in _DETECTORS.items()})


def is_newsletter(email: dict) -> bool:
    """True only when the evidence is conclusive (skip-the-LLM tier)."""
    return decide(email).tier("NEWSLETTER") == "certain"


def prompt_fields(decision: Decision) -> dict:
    """Compact evidence for the LLM: what we saw, so it need not guess."""
    v = decision.verdicts["NEWSLETTER"]
    a = decision.assessment
    likelihood = {"certain": "high", "likely": "medium",
                  "unlikely": "low", "blocked": "excluded"}[v.tier]
    out = {"newsletter_likelihood": likelihood}
    bulk = [f"{n}" for n, _ in sorted(a.signals["bulk"], key=lambda s: -s[1])][:6]
    counter = [f"{n}" for f in FAMILIES if f != "bulk" for n, _ in a.signals[f]][:4]
    if bulk:
        out["mass_mail_evidence"] = bulk
    if counter or v.blockers or a.cautions:
        out["not_newsletter_evidence"] = list(v.blockers) + list(a.cautions) + counter
    return out


def guard(category: str, decision: Optional[Decision]) -> str:
    """Clamp an LLM category that contradicts hard evidence."""
    cat = (category or "").strip().upper()
    if cat == "NEWSLETTER" and decision is not None \
            and decision.tier("NEWSLETTER") == "blocked":
        return "NORMAL"
    return cat


_CATEGORY_ALIASES = {"ZOOM CALLS": "ZOOM", "ZOOM CALL": "ZOOM", "NEWSLETTERS": "NEWSLETTER"}


def normalise_category(raw, allowed: Tuple[str, ...], default: str = "NORMAL") -> str:
    """Map LLM output onto the closed category set; unknown -> default."""
    cat = str(raw or "").strip().upper()
    cat = _CATEGORY_ALIASES.get(cat, cat)
    return cat if cat in allowed else default


# One definition of NEWSLETTER shared by every prompt. The three prompts used
# to carry three different (and in the thread prompt, absent) definitions.
NEWSLETTER_RULES = """\
NEWSLETTER = one-to-many mail written for an audience, not for this recipient personally:
editorial newsletters and digests (Morning Brew, Tech Brew, Healthcare Brew, Substack, LinkedIn newsletters, trade
press such as Fierce or Becker's), vendor marketing campaigns, promotions and sales, webinar/event/whitepaper
invitations, product announcements, sponsored or partner content, referral and subscription pitches.
Decide by WHO it is addressed to and WHAT it asks of the reader, never by topic or tone:
- News stories, ads, many links, referral/subscribe prompts and sponsor blocks are NORMAL parts of a newsletter and
  are reasons FOR the NEWSLETTER category, not against it.
- A newsletter that discusses contracts, payments, HEDIS, ACOs, DocuSign, Zoom or any business topic AS NEWS is still
  a NEWSLETTER.
- It is NOT a newsletter when it concerns this organization's own business: a signature/approval request, a specific
  patient, claim, account or order, a reply inside a conversation, a message from a named colleague, or a message with
  attachments to work on - even if it carries an unsubscribe footer (payers, labs, EHR vendors and e-signature
  platforms add footers to transactional mail).
- Each email may include `newsletter_likelihood` (high/medium/low/excluded), `mass_mail_evidence` and
  `not_newsletter_evidence`, computed from the full message including parts you cannot see. Treat them as facts about
  the email. "high": choose NEWSLETTER unless the email clearly concerns this organization's own business. "excluded":
  never choose NEWSLETTER. "low": do not choose NEWSLETTER on tone alone."""


def newsletter_stub_summary(sender: str, subject: str) -> str:
    return (f"Newsletter from {sender or 'unknown sender'}. "
            f"Subject: {subject}. Automated digest - no action required.")
