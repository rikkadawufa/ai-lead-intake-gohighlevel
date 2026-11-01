"""Check T1–T11 against the run logs, GoHighLevel and the demo inbox, then write output/results.md.

T1–T8 are the same scenarios as the HubSpot and Salesforce versions; T9–T11 (Facebook lead form) are reported separately.
Every number in the results comes from this script, not from the AI.
  python scripts/collect_results.py            # evaluate the latest initial batch and reviews
  python scripts/collect_results.py --replay   # evaluate the latest replay batch (idempotency)
"""
import argparse
import email
import imaplib
import json
from datetime import datetime
from email.header import decode_header, make_header
from email.utils import parsedate_to_datetime
from pathlib import Path

try:
    from .demo_common import IDS_PATH, OUTPUT, RUN_LOG_DIR, by_id, fixture_email, load_fixtures, read_json_files, source_id
    from .envfile import is_meta_mock, is_mock, load_env, require
    from .ghl_setup import client_from_env
    from .send_fixtures import seen_leadgen_ids, sent_leadgen_ids
except ImportError:
    from demo_common import IDS_PATH, OUTPUT, RUN_LOG_DIR, by_id, fixture_email, load_fixtures, read_json_files, source_id
    from envfile import is_meta_mock, is_mock, load_env, require
    from ghl_setup import client_from_env
    from send_fixtures import seen_leadgen_ids, sent_leadgen_ids

QUALIFIED_STAGE = "New – qualified"
REVIEW_STAGE = "Needs review"


def latest_send_log(mode, output=OUTPUT):
    paths = sorted(Path(output).glob(f"send-log-{mode}-*.json"))
    return json.loads(paths[-1].read_text(encoding="utf-8")) if paths else None


def logs_since(logs, started):
    return [log for log in logs if log.get("ts", "") >= started]


def find_log(logs, sid, action=None):
    matches = [log for log in logs if log.get("source_id") == sid and (action is None or log.get("action") == action)]
    return matches[-1] if matches else None


def row(fixture_id, title, checks, extra=False):
    failed = [f"{name}: expected {expected!r}, got {actual!r}" for name, expected, actual in checks if expected != actual]
    shown = "; ".join(f"{name}={actual}" for name, _, actual in checks)
    return {"id": fixture_id, "title": title, "pass": not failed, "observed": shown, "problems": failed, "extra": extra}


def summarize(rows, contact_count):
    core = [item for item in rows if not item["extra"]]
    extra = [item for item in rows if item["extra"]]
    return {"passed": sum(item["pass"] for item in core), "total": len(core),
            "extra_passed": sum(item["pass"] for item in extra), "extra_total": len(extra), "demo_records": contact_count}


def evaluate(fixtures, reviews, logs, send_log, review_log, people, sent_mail, redirect_to, leadgen_ids=None):
    fx = by_id(fixtures)
    sid = {fixture["id"]: source_id(fixture, fixtures, leadgen_ids) for fixture in fixtures}
    sends = {item["id"]: item for item in (send_log or {}).get("results", [])}
    log = lambda fixture_id, action=None: find_log(logs, sid[fixture_id], action) or {}
    first = {k: log(k, "created") or log(k, "updated") for k in ("T1", "T2", "T4", "T5", "T7", "T9", "T10") if k in sid}
    person = lambda fixture_id: next((item for item in people if (item.get("email") or "").lower() == (fixture_email(fx[fixture_id], fixtures) or "")), {})
    same_contact = lambda entry, fixture_id: bool(first[fixture_id].get("contact_id")) and entry.get("contact_id") == first[fixture_id].get("contact_id")
    dana, sam, riley, jordan = person("T1"), person("T5"), person("T7"), person("T4")
    t1_review = next((item for item in (review_log or {}).get("results", []) if item.get("fixture") == "T1"), {})
    demo_mail = [item for item in sent_mail if item["to"] == redirect_to]
    t1_edit = next((item.get("edit_body") for item in reviews if item["fixture"] == "T1"), "")
    edited_line = next((line for line in t1_edit.split("\n") if len(line) > 60), None)
    edited_mail = [item for item in demo_mail if edited_line and edited_line in item["body"]]
    contacts_with = lambda address: sum((item.get("email") or "").lower() == address for item in people)
    rows = [
        row("T1", fx["T1"]["title"], [
            ("action", "created", first["T1"].get("action")), ("tier", "qualified", first["T1"].get("tier")),
            ("stage", QUALIFIED_STAGE, first["T1"].get("stage")), ("follow-up task", True, bool(first["T1"].get("task_id"))),
            ("draft", "approved", first["T1"].get("draft")), ("edited", True, first["T1"].get("edited")),
        ]),
        row("T2", fx["T2"]["title"], [
            ("action", "updated", first["T2"].get("action")), ("same contact as T1", True, same_contact(first["T2"], "T1")),
            ("form + email inquiries on Dana", 2, len([item for item in logs if item.get("contact_id") == dana.get("id") and item.get("action") in ("created", "updated") and item.get("source") != "meta_lead"])),
            ("final tier", "qualified", dana.get("lead_tier")), ("same opportunity", True, bool(first["T1"].get("opportunity_id")) and first["T2"].get("opportunity_id") == first["T1"].get("opportunity_id")),
            ("second task", False, bool(first["T2"].get("task_id"))), ("draft", "approved", first["T2"].get("draft")), ("edited", False, first["T2"].get("edited")),
        ]),
        row("T3", fx["T3"]["title"], [
            ("action", "duplicate_submission", log("T3", "duplicate_submission").get("action")),
            ("same contact as T1", True, same_contact(log("T3", "duplicate_submission"), "T1")),
            ("drafts for this submission", 1, len([item for item in logs if item.get("source_id") == sid["T1"] and item.get("draft") != "none"])),
        ]),
        row("T4", fx["T4"]["title"], [
            ("action", "created", first["T4"].get("action")), ("tier", "not_qualified", first["T4"].get("tier")),
            ("opportunities", 0, jordan.get("opportunities")), ("draft", "none", first["T4"].get("draft")),
        ]),
        row("T5", fx["T5"]["title"], [
            ("action", "created", first["T5"].get("action")), ("tier", "needs_review", first["T5"].get("tier")), ("stage", REVIEW_STAGE, sam.get("stage")),
            ("draft", "rejected", first["T5"].get("draft")), ("sent", None, first["T5"].get("sent_to")),
        ]),
        row("T6", fx["T6"]["title"], [
            ("HTTP status", 400, sends.get("T6", {}).get("http_status")),
            ("Slack alert", 1, len(log("T6", "rejected_input").get("alerts", []))),
            ("GoHighLevel contact", None, log("T6", "rejected_input").get("contact_id")),
        ]),
        row("T7", fx["T7"]["title"], [
            ("action", "created", first["T7"].get("action")), ("tier", "needs_review", first["T7"].get("tier")), ("stage", REVIEW_STAGE, riley.get("stage")),
            ("llm_ok", False, first["T7"].get("llm_ok")), ("draft", "none", first["T7"].get("draft")), ("Slack alert", 1, len(first["T7"].get("alerts", []))),
        ]),
        row("T8", "Human review: edit + approve, approve, reject", [
            ("incomplete review refused", 422, t1_review.get("incomplete_review_status")),
            ("T1 reply sent to demo inbox", redirect_to, first["T1"].get("sent_to")),
            ("T1 reviewer", "Morgan Lee (Ops)", first["T1"].get("reviewer")),
            ("emails with the edited T1 text", 1, len(edited_mail)),
            ("T5 nothing sent", None, first["T5"].get("sent_to")),
            ("replies in demo inbox", 2, len(demo_mail)),
        ]),
    ]
    if "T9" in fx:
        rows.append(row("T9", fx["T9"]["title"], [
            ("action", "updated", first["T9"].get("action")), ("same contact as T1", True, same_contact(first["T9"], "T1")),
            ("contacts with Dana's email", 1, contacts_with(fixture_email(fx["T1"], fixtures))),
            ("inquiry notes on Dana", 3, dana.get("inquiry_notes")), ("opportunities on Dana", 1, dana.get("opportunities")), ("tasks on Dana", 1, dana.get("tasks")),
            ("draft", "rejected", first["T9"].get("draft")),
        ], extra=True))
    if "T10" in fx:
        elena = person("T10")
        rows.append(row("T10", fx["T10"]["title"], [
            ("action", "created", first["T10"].get("action")), ("source", "Facebook lead form", elena.get("source")),
            ("tier", "qualified", first["T10"].get("tier")), ("stage", QUALIFIED_STAGE, elena.get("stage")), ("tasks", 1, elena.get("tasks")),
            ("draft", "rejected", first["T10"].get("draft")),
        ], extra=True))
    if "T11" in fx:
        repeat = log("T11", "duplicate_submission")
        rows.append(row("T11", fx["T11"]["title"], [
            ("action", "duplicate_submission", repeat.get("action")), ("same contact as T10", True, same_contact(repeat, "T10")),
            ("inquiry notes on Elena", 1, person("T10").get("inquiry_notes")),
        ], extra=True))
    return rows, summarize(rows, len(people))


def evaluate_replay(fixtures, logs, replay_log, records_before, records_after, leadgen_ids=None):
    sends = {item["id"]: item for item in replay_log.get("results", [])}
    rows = []
    for fixture in fixtures:
        sid = source_id(fixture, fixtures, leadgen_ids)
        if fixture["id"] == "T6":
            rows.append(row("T6", fixture["title"], [("HTTP status", 400, sends.get("T6", {}).get("http_status"))]))
            continue
        entry = find_log(logs, sid) or {}
        rows.append(row(fixture["id"], fixture["title"], [("action", "duplicate_submission", entry.get("action")), ("new draft", "none", entry.get("draft"))], extra=bool(fixture.get("extra"))))
    rows.append(row("ALL", "Contacts and opportunities unchanged after replay", [("demo contacts / opportunities", records_before, records_after)]))
    return rows, summarize(rows, records_after)


def ghl_state(client, fixtures, ids):
    """One row per demo contact, read back from GoHighLevel."""
    emails = sorted({address for address in (fixture_email(item, fixtures) for item in fixtures) if address})
    stage_names = {value: name for name, value in ids["stages"].items()}
    state = []
    for contact in client.demo_contacts(emails):
        full = client.get_contact(contact["id"])
        fields = {item.get("id"): item.get("value") for item in full.get("customFields", [])}
        notes = client.notes(contact["id"])
        opportunities = client.opportunities(contact["id"], ids["pipelineId"], status="all")
        open_one = next((item for item in opportunities if item.get("status", "open") == "open"), None)
        state.append({
            "id": contact["id"], "email": (full.get("email") or "").lower() or None, "source": full.get("source"),
            "lead_tier": fields.get(ids["fields"]["lead_tier"]),
            "inquiry_notes": sum(str(item.get("body", "")).startswith("Inquiry via") for item in notes),
            "decision_notes": sum(str(item.get("body", "")).startswith("AI reply") for item in notes),
            "tasks": len(client.tasks(contact["id"])),
            "opportunities": len(opportunities),
            "stage": stage_names.get(open_one.get("pipelineStageId")) if open_one else None,
        })
    return state


def record_count(people):
    return {"contacts": len(people), "opportunities": sum(item["opportunities"] for item in people)}


def demo_inbox_replies(values, since_iso):
    """Approved replies that landed in the demo inbox (the REPLY_REDIRECT_TO plus-address)."""
    gmail, password = require(values, "GMAIL_ADDRESS"), require(values, "GMAIL_APP_PASSWORD").replace(" ", "")
    started = datetime.fromisoformat(since_iso)
    since = started.strftime("%d-%b-%Y")
    found = []
    imap = imaplib.IMAP4_SSL("imap.gmail.com")
    try:
        imap.login(gmail, password)
        imap.select("INBOX", readonly=True)
        _, data = imap.search(None, "SINCE", since, "SUBJECT", "demo")
        for num in data[0].split():
            _, parts = imap.fetch(num, "(BODY.PEEK[])")
            message = email.message_from_bytes(parts[0][1])
            subject = str(make_header(decode_header(message.get("Subject", ""))))
            # IMAP SINCE only filters by day, so drop replies from earlier runs on the same day.
            if not subject.startswith("[demo") or parsedate_to_datetime(message.get("Date")) < started:
                continue
            body = message.get_payload(decode=True) if not message.is_multipart() else message.get_payload(0).get_payload(decode=True)
            found.append({"to": message.get("To", "").strip().lower(), "subject": subject, "body": (body or b"").decode("utf-8", "replace").replace("\r\n", "\n"), "date": message.get("Date")})
    finally:
        imap.logout()
    return found


def summary_line(summary, platform):
    extra = f" · Facebook lead form scenarios: {summary['extra_passed']} / {summary['extra_total']}" if summary["extra_total"] else ""
    records = summary["demo_records"]
    shown = f"{records['contacts']} contacts, {records['opportunities']} opportunities" if isinstance(records, dict) else records
    return f"**{summary['passed']} / {summary['total']} passed**{extra} · demo records in {platform}: {shown}"


def write_results(rows, summary, title, platform, stem="results"):
    lines = [f"# {title}", "", f"Generated {datetime.now().isoformat(timespec='seconds')} by `scripts/collect_results.py` against {platform} (counts come from code, not the AI).", "",
             summary_line(summary, platform), "", "| # | Scenario | Result | Observed |", "|---|---|---|---|"]
    for item in rows:
        lines.append(f"| {item['id']} | {item['title']} | {'PASS' if item['pass'] else 'FAIL'} | {item['observed']} |")
    problems = [f"- {item['id']}: {problem}" for item in rows for problem in item["problems"]]
    if problems:
        lines += ["", "## Problems", *problems]
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / f"{stem}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (OUTPUT / f"{stem}.json").write_text(json.dumps({"generated": datetime.now().isoformat(timespec="seconds"), "platform": platform, "summary": summary, "rows": rows}, indent=2, ensure_ascii=False), encoding="utf-8")
    print("\n".join(lines))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--replay", action="store_true")
    parser.add_argument("--no-inbox", action="store_true", help="skip the Gmail check (T8 inbox counts will fail)")
    args = parser.parse_args()
    values = load_env()
    fixtures, reviews = load_fixtures()
    client = client_from_env(values)
    ids = json.loads(IDS_PATH.read_text(encoding="utf-8"))
    platform = "the local GoHighLevel mock" if is_mock(values) else "GoHighLevel"
    all_logs = read_json_files(RUN_LOG_DIR)
    leadgen_ids = None if is_meta_mock(values) else {**sent_leadgen_ids(), **seen_leadgen_ids(all_logs)}
    people = ghl_state(client, fixtures, ids)
    if args.replay:
        replay = latest_send_log("replay")
        if not replay:
            raise SystemExit("No replay batch found; run send_fixtures.py --replay first.")
        before = json.loads((OUTPUT / "results.json").read_text(encoding="utf-8"))["summary"]["demo_records"] if (OUTPUT / "results.json").exists() else None
        rows, summary = evaluate_replay(fixtures, logs_since(all_logs, replay["run_started"]), replay, before, record_count(people), leadgen_ids)
        write_results(rows, summary, "Replay check (same batch sent twice)", platform, stem="results-replay")
        return
    batch = latest_send_log("initial")
    if not batch:
        raise SystemExit("No initial batch found; run send_fixtures.py first.")
    logs = logs_since(all_logs, batch["run_started"])
    mail = [] if args.no_inbox else demo_inbox_replies(values, batch["run_started"])
    rows, summary = evaluate(fixtures, reviews, logs, batch, latest_send_log("review"), people, mail, values.get("REPLY_REDIRECT_TO", "").lower(), leadgen_ids)
    summary["demo_records"] = record_count(people)
    write_results(rows, summary, "Lead intake test results (T1–T8, plus T9–T11)", platform)


if __name__ == "__main__":
    main()
