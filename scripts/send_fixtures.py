"""Send the T1–T11 fixtures (form POSTs, SMTP test emails, Facebook lead form leads) and run the T8 reviews (plus T9's and T10's).

Facebook leads: against the local mock they are seeded into the mock Graph and announced with a signed webhook POST.
Against the real Meta app they are created with Meta's test lead API (POST /{form_id}/test_leads, the same thing the
Lead Ads Testing Tool does); Meta then calls the webhook itself. T11 re-posts T10's signed event, as Meta does when it
redelivers.

  python scripts/send_fixtures.py --dry-run          # print what would be sent
  python scripts/send_fixtures.py                    # send the fixtures, one every --gap seconds
  python scripts/send_fixtures.py --review           # submit the T8 review decisions
  python scripts/send_fixtures.py --replay           # send the same batch again (idempotency check)
"""
import argparse
import hashlib
import hmac
import json
import smtplib
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr

try:
    from .demo_common import FORM_URL, META_WEBHOOK_URL, OUTPUT, REVIEW_DIR, RUN_LOG_DIR, base_fixture, load_fixtures, read_json_files, safe_id, source_id
    from .envfile import GRAPH_API, MOCK_ON_HOST, host_url, is_meta_mock, load_env, mask, require
except ImportError:
    from demo_common import FORM_URL, META_WEBHOOK_URL, OUTPUT, REVIEW_DIR, RUN_LOG_DIR, base_fixture, load_fixtures, read_json_files, safe_id, source_id
    from envfile import GRAPH_API, MOCK_ON_HOST, host_url, is_meta_mock, load_env, mask, require

GRAPH_VERSION = "v21.0"


def now():
    return datetime.now(timezone.utc).isoformat()


def http_post(url, data, headers):
    request = urllib.request.Request(url, data=data, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


def form_request(fixture, fixtures):
    base = base_fixture(fixture, fixtures)
    body = {**base["payload"], "submission_id": base["submission_id"]}
    headers = {"Content-Type": "application/json"}
    if base.get("break_llm"):
        headers["x-demo-break-llm"] = "1"
    return body, headers


def email_message(fixture, gmail):
    message = EmailMessage()
    message["From"] = formataddr((f"{fixture['from_name']} (demo sender)", gmail))
    message["To"] = gmail
    message["Reply-To"] = formataddr((fixture["from_name"], fixture["reply_to"]))
    message["Subject"] = fixture["subject"]
    message["Message-ID"] = fixture["message_id"]
    message.set_content(fixture["body"])
    return message


def http_json(method, url, body=None, headers=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(raw)
        except ValueError:
            return error.code, {"message": raw[:300]}


def field_data(fixture):
    return [{"name": name, "values": [value]} for name, value in fixture["field_data"].items()]


def leadgen_event(leadgen_id, page_id, form_id):
    now_ts = int(time.time())
    return {"object": "page", "entry": [{"id": page_id, "time": now_ts, "changes": [{"field": "leadgen", "value": {"leadgen_id": leadgen_id, "page_id": page_id, "form_id": form_id, "created_time": now_ts}}]}]}


def signed_post(url, payload, app_secret):
    """Meta signs the exact bytes it sends; so do we."""
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    signature = "sha256=" + hmac.new(app_secret.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return http_post(url, raw, {"Content-Type": "application/json", "X-Hub-Signature-256": signature})


def seen_leadgen_ids(run_logs):
    """Leadgen ids Meta assigned in a live run, keyed by fixture id (read from the run log)."""
    ids = {}
    for log in run_logs:
        if str(log.get("source_id", "")).startswith("meta:") and log.get("fixture_id"):
            ids[log["fixture_id"]] = log["source_id"].split(":", 1)[1]
    return ids


def sent_leadgen_ids(output=None):
    """Test lead ids this script created on the real form, keyed by fixture id (read from the send logs)."""
    ids = {}
    for path in sorted(Path(output or OUTPUT).glob("send-log-initial-*.json")):
        for entry in json.loads(path.read_text(encoding="utf-8")).get("results", []):
            if entry.get("test_lead_id"):
                ids[entry["id"]] = entry["test_lead_id"]
    return ids


def known_leadgen_ids(created=None):
    """Every leadgen id we know of: run logs (Meta delivered it), send logs and this batch (we created it)."""
    ids = sent_leadgen_ids()
    ids.update(seen_leadgen_ids(read_json_files(RUN_LOG_DIR)))
    ids.update(created or {})
    return ids


def form_question_keys(graph, form_id, token):
    status, payload = http_json("GET", f"{graph}/{GRAPH_VERSION}/{form_id}?fields=questions&access_token={token}")
    if status != 200:
        raise RuntimeError(f"could not read the form questions ({status}): {payload.get('error', {}).get('message', payload)}")
    return [item.get("key") for item in payload.get("questions", []) if item.get("key")]


def map_to_form(fields, keys):
    """Fixture field names to the keys of the real form; questions the form doesn't ask are left out."""
    mapped = []
    for item in fields:
        key = next((key for key in keys if key == item["name"] or key[:16] == item["name"][:16]), None)
        if key:
            mapped.append({"name": key, "values": item["values"]})
    return mapped


def create_test_lead(values, fixture):
    graph = host_url(values.get("META_GRAPH_URL"), GRAPH_API)
    form_id, token = require(values, "META_FORM_ID"), require(values, "META_PAGE_TOKEN")
    # Meta keeps one test lead per form; delete the previous one first.
    status, payload = http_json("GET", f"{graph}/{GRAPH_VERSION}/{form_id}/test_leads?access_token={token}")
    for lead in (payload.get("data", []) if status == 200 else []):
        http_json("DELETE", f"{graph}/{GRAPH_VERSION}/{lead['id']}?access_token={token}")
    body = {"field_data": map_to_form(field_data(fixture), form_question_keys(graph, form_id, token))}
    return http_json("POST", f"{graph}/{GRAPH_VERSION}/{form_id}/test_leads?access_token={token}", body)


def send_meta(values, fixture, fixtures, created=None, self_notify=False, replay=False):
    base = base_fixture(fixture, fixtures)
    secret = require(values, "META_APP_SECRET")
    page_id = values.get("META_PAGE_ID") or "mockPage01"
    form_id = values.get("META_FORM_ID") or "mockForm01"
    created = {} if created is None else created
    # A redelivery (T11, or any Facebook lead in a replay) re-posts a lead Meta already has, as Meta does on retry.
    if fixture.get("resend_of") or (replay and not is_meta_mock(values)):
        leadgen = base["mock_leadgen_id"] if is_meta_mock(values) else known_leadgen_ids(created).get(base["id"])
        if not leadgen:
            return {"error": f"no leadgen id known for {base['id']} yet, so there is nothing to redeliver"}
        status, text = signed_post(META_WEBHOOK_URL, leadgen_event(leadgen, page_id, form_id), secret)
        return {"channel": "meta_lead", "redelivered": leadgen, "http_status": status, "response": text[:200]}
    if is_meta_mock(values):
        lead = {"id": base["mock_leadgen_id"], "form_id": form_id, "created_time": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+0000"), "field_data": field_data(base)}
        http_json("POST", f"{MOCK_ON_HOST}/__seed/lead", lead)
        status, text = signed_post(META_WEBHOOK_URL, leadgen_event(lead["id"], page_id, form_id), secret)
        return {"channel": "meta_lead", "mock_leadgen_id": lead["id"], "http_status": status, "response": text[:200]}
    status, payload = create_test_lead(values, base)
    entry = {"channel": "meta_lead", "test_lead_status": status, "test_lead_id": payload.get("id"), "response": mask(json.dumps(payload)[:200], values)}
    if payload.get("id"):
        created[base["id"]] = payload["id"]
    if self_notify and payload.get("id"):
        # Meta didn't deliver leadgen webhooks for this development-mode app, so we send the same signed event it would.
        # n8n still verifies the signature and reads the lead from the real Graph API.
        notify_status, text = signed_post(META_WEBHOOK_URL, leadgen_event(payload["id"], page_id, form_id), secret)
        entry.update({"self_notified": True, "http_status": notify_status, "notify_response": text[:200]})
    return entry


def describe(fixture, fixtures):
    base = base_fixture(fixture, fixtures)
    if base["channel"] == "meta_lead":
        if fixture.get("resend_of"):
            return f"Signed webhook POST {META_WEBHOOK_URL} redelivering {base['id']}'s leadgen event"
        return "Facebook lead form lead (mock: seed + signed webhook; live: POST /{form_id}/test_leads)\n    " + json.dumps(base["field_data"])
    if base["channel"] == "form":
        body, headers = form_request(fixture, fixtures)
        extra = " + header x-demo-break-llm: 1" if "x-demo-break-llm" in headers else ""
        return f"POST {FORM_URL}{extra}\n    {json.dumps(body)}"
    return f"SMTP email to the demo inbox, Reply-To: {fixture['from_name']} <{fixture['reply_to']}>, Message-ID {fixture['message_id']}\n    Subject: {fixture['subject']}"


def send_batch(values, fixtures, only, gap, mode, dry_run, self_notify=False):
    selected = [fixture for fixture in fixtures if not only or fixture["id"] in only]
    if dry_run:
        for fixture in selected:
            print(f"[{fixture['id']}] {fixture['title']}\n  {describe(fixture, fixtures)}")
        return None
    log = {"mode": mode, "run_started": now(), "results": []}
    if self_notify:
        log["self_notify"] = True
    created = {}
    for index, fixture in enumerate(selected):
        if index:
            time.sleep(gap)
        entry = {"id": fixture["id"], "sent_at": now()}
        try:
            if base_fixture(fixture, fixtures)["channel"] == "meta_lead":
                entry.update(send_meta(values, fixture, fixtures, created, self_notify, replay=mode == "replay"))
            elif base_fixture(fixture, fixtures)["channel"] == "form":
                body, headers = form_request(fixture, fixtures)
                status, text = http_post(FORM_URL, json.dumps(body).encode("utf-8"), headers)
                entry.update({"channel": "form", "http_status": status, "response": text[:300]})
            else:
                with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context()) as smtp:
                    gmail = require(values, "GMAIL_ADDRESS")
                    smtp.login(gmail, require(values, "GMAIL_APP_PASSWORD").replace(" ", ""))
                    smtp.send_message(email_message(fixture, gmail))
                entry.update({"channel": "email", "smtp": "sent"})
        except Exception as error:  # keep going so one failure is visible next to the others
            entry.update({"error": mask(f"{type(error).__name__}: {error}", values)})
        print(f"[{fixture['id']}] {entry.get('http_status', entry.get('test_lead_status', entry.get('smtp', entry.get('error'))))}")
        log["results"].append(entry)
    log["run_finished"] = now()
    return log


def reject_all(reviews):
    """Mock runs without Gmail: same reviewers and order, every decision a reject, so nothing can be sent."""
    return [{"fixture": item["fixture"], "decision": "reject", "reviewer": item["reviewer"]} for item in reviews]


def submit_reviews(values, fixtures, reviews):
    log = {"mode": "review", "run_started": now(), "results": []}
    by_fixture = {fixture["id"]: fixture for fixture in fixtures}
    leadgen_ids = known_leadgen_ids()
    for index, review in enumerate(reviews):
        sid = source_id(by_fixture[review["fixture"]], fixtures, leadgen_ids)
        meta_path = REVIEW_DIR / f"{safe_id(sid)}.json"
        if not meta_path.exists():
            print(f"[{review['fixture']}] no review page yet ({meta_path.name}); is the draft still being made?")
            log["results"].append({"fixture": review["fixture"], "error": "no_review_page"})
            continue
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        entry = {"fixture": review["fixture"], "decision": review["decision"]}
        if index == 0:
            # Show that an incomplete review is refused and nothing is sent.
            status, _ = http_post(meta["resume_url"], urllib.parse.urlencode({"decision": review["decision"]}).encode(), headers)
            entry["incomplete_review_status"] = status
            time.sleep(3)
        fields = {"reviewer": review["reviewer"], "decision": review["decision"]}
        if review.get("edit_body"):
            fields["body"] = review["edit_body"]
        status, text = http_post(meta["resume_url"], urllib.parse.urlencode(fields).encode(), headers)
        entry.update({"http_status": status, "response": text[:200]})
        print(f"[{review['fixture']}] {review['decision']} -> {status}" + (f" (incomplete first try -> {entry['incomplete_review_status']})" if "incomplete_review_status" in entry else ""))
        log["results"].append(entry)
        time.sleep(3)
    log["run_finished"] = now()
    return log


def save(log):
    OUTPUT.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = OUTPUT / f"send-log-{log['mode']}-{stamp}.json"
    path.write_text(json.dumps(log, indent=2), encoding="utf-8")
    print(f"Saved {path.relative_to(OUTPUT.parent)}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="comma-separated fixture ids, e.g. T1,T2")
    parser.add_argument("--gap", type=float, default=8.0, help="seconds between sends (lets each inquiry finish before the next one for the same person arrives)")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--review", action="store_true", help="submit the review decisions (T8, and the rejects for T9 and T10)")
    parser.add_argument("--replay", action="store_true", help="send the same batch again")
    parser.add_argument("--self-notify", action="store_true", help="live Meta: after creating each test lead, send its signed leadgen event ourselves (for an app Meta doesn't deliver webhooks to)")
    parser.add_argument("--reject-all", action="store_true", help="with --review: reject every draft (mock runs without Gmail)")
    args = parser.parse_args()
    values = load_env()
    fixtures, reviews = load_fixtures()
    if args.review:
        save(submit_reviews(values, fixtures, reject_all(reviews) if args.reject_all else reviews))
        return
    only = set(args.only.split(",")) if args.only else None
    log = send_batch(values, fixtures, only, args.gap, "replay" if args.replay else "initial", args.dry_run, args.self_notify)
    if log:
        save(log)


if __name__ == "__main__":
    main()
