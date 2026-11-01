import copy
import unittest

from scripts.collect_results import evaluate, evaluate_replay, find_log, logs_since
from scripts.compare_results import REFERENCE, load, render
from scripts.demo_common import load_fixtures, safe_id, source_id
from scripts.send_fixtures import leadgen_event, map_to_form, seen_leadgen_ids, sent_leadgen_ids

FIXTURES, REVIEWS = load_fixtures()
SID = {fixture["id"]: source_id(fixture, FIXTURES) for fixture in FIXTURES}
REDIRECT = "leads+replies@gmail.com"
EDITED = next(line for line in REVIEWS[0]["edit_body"].split("\n") if len(line) > 60)


def log(fid, action, **extra):
    return {"ts": "2026-11-03T00:00:01", "source_id": SID[fid], "source": "meta_lead" if SID[fid].startswith("meta:") else "form", "action": action, "alerts": [], "draft": "none", **extra}


def passing_inputs():
    logs = [
        log("T1", "created", tier="qualified", contact_id="c1", opportunity_id="o1", stage="New – qualified", task_id="k1", draft="approved", edited=True, sent_to=REDIRECT, reviewer="Morgan Lee (Ops)"),
        log("T2", "updated", contact_id="c1", opportunity_id="o1", stage="New – qualified", task_id=None, draft="approved", edited=False),
        log("T3", "duplicate_submission", contact_id="c1"),
        log("T4", "created", tier="not_qualified", contact_id="c2"),
        log("T5", "created", tier="needs_review", contact_id="c3", draft="rejected", sent_to=None),
        log("T6", "rejected_input", alerts=["x"]),
        log("T7", "created", tier="needs_review", llm_ok=False, contact_id="c4", alerts=["x"]),
        log("T9", "updated", contact_id="c1", opportunity_id="o1", draft="rejected"),
        log("T10", "created", tier="qualified", contact_id="c5", opportunity_id="o5", task_id="k5", draft="rejected"),
        log("T11", "duplicate_submission", contact_id="c5"),
    ]
    send_log = {"results": [{"id": "T6", "http_status": 400}]}
    review_log = {"results": [{"fixture": "T1", "incomplete_review_status": 422}]}
    people = [
        {"id": "c1", "email": "dana.whitfield@example.com", "lead_tier": "qualified", "inquiry_notes": 3, "opportunities": 1, "tasks": 1, "stage": "New – qualified", "source": "Website form"},
        {"id": "c2", "email": "jordan.blake@example.org", "lead_tier": "not_qualified", "inquiry_notes": 1, "opportunities": 0, "tasks": 0, "stage": None},
        {"id": "c3", "email": "sam.okafor@example.com", "lead_tier": "needs_review", "inquiry_notes": 1, "opportunities": 1, "tasks": 0, "stage": "Needs review"},
        {"id": "c4", "email": "riley.chen@example.com", "lead_tier": "needs_review", "inquiry_notes": 1, "opportunities": 1, "tasks": 0, "stage": "Needs review"},
        {"id": "c5", "email": "elena.vasquez@example.com", "lead_tier": "qualified", "inquiry_notes": 1, "opportunities": 1, "tasks": 1, "stage": "New – qualified", "source": "Facebook lead form"},
    ]
    mail = [{"to": REDIRECT, "subject": "[demo → dana] a", "body": EDITED}, {"to": REDIRECT, "subject": "[demo → dana] b", "body": "other"}]
    return logs, send_log, review_log, people, mail


def run(logs, send_log, review_log, people, mail):
    return evaluate(FIXTURES, REVIEWS, logs, send_log, review_log, people, mail, REDIRECT)


def problems(rows):
    return [row["problems"] for row in rows if not row["pass"]]


class ResultTests(unittest.TestCase):
    def test_all_pass_on_expected_state(self):
        rows, summary = run(*passing_inputs())
        self.assertEqual((summary["passed"], summary["total"]), (8, 8), problems(rows))
        self.assertEqual((summary["extra_passed"], summary["extra_total"]), (3, 3), problems(rows))

    def test_second_contact_for_dana_fails_t9(self):
        logs, send, review, people, mail = passing_inputs()
        people.append({"id": "c9", "email": "dana.whitfield@example.com", "inquiry_notes": 1, "opportunities": 1, "tasks": 1})
        logs[7]["contact_id"] = "c9"
        rows, _ = run(logs, send, review, people, mail)
        t9 = next(row for row in rows if row["id"] == "T9")
        self.assertFalse(t9["pass"])
        self.assertTrue(any("same contact as T1" in item for item in t9["problems"]))

    def test_second_task_or_opportunity_on_t2_fails(self):
        logs, *rest = passing_inputs()
        logs[1]["task_id"] = "k2"
        logs[1]["opportunity_id"] = "o2"
        rows, _ = run(logs, *rest)
        t2 = next(row for row in rows if row["id"] == "T2")
        self.assertEqual(len(t2["problems"]), 2, t2["problems"])

    def test_not_qualified_with_an_opportunity_fails_t4(self):
        logs, send, review, people, mail = passing_inputs()
        people[1]["opportunities"] = 1
        rows, _ = run(logs, send, review, people, mail)
        self.assertFalse(next(row for row in rows if row["id"] == "T4")["pass"])

    def test_third_email_in_the_inbox_fails_t8(self):
        logs, send, review, people, mail = passing_inputs()
        mail.append({"to": REDIRECT, "subject": "[demo → sam] c", "body": "x"})
        rows, _ = run(logs, send, review, people, mail)
        self.assertFalse(next(row for row in rows if row["id"] == "T8")["pass"])

    def test_live_leadgen_ids_come_from_the_run_log(self):
        live_logs = [{"source_id": "meta:1111", "fixture_id": "T10"}, {"source_id": "meta:2222", "fixture_id": "T9"}, {"source_id": "form:x", "fixture_id": "T1"}]
        ids = seen_leadgen_ids(live_logs)
        self.assertEqual(ids, {"T10": "1111", "T9": "2222"})
        by = {fixture["id"]: fixture for fixture in FIXTURES}
        self.assertEqual(source_id(by["T11"], FIXTURES, ids), "meta:1111")
        self.assertEqual(source_id(by["T10"], FIXTURES), "meta:900000000000010")

    def test_created_test_lead_ids_come_from_the_send_logs(self):
        # A qualified lead's run log is written only after review, so T11 and the review step can't wait for it.
        import json
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "send-log-initial-20261101-000000.json").write_text(json.dumps({"results": [{"id": "T9", "test_lead_id": "333"}, {"id": "T1", "http_status": 202}]}), encoding="utf-8")
            Path(tmp, "send-log-initial-20261101-010000.json").write_text(json.dumps({"results": [{"id": "T9", "test_lead_id": "444"}, {"id": "T10", "test_lead_id": "555"}]}), encoding="utf-8")
            Path(tmp, "send-log-replay-20261101-020000.json").write_text(json.dumps({"results": [{"id": "T10", "test_lead_id": "999"}]}), encoding="utf-8")
            self.assertEqual(sent_leadgen_ids(tmp), {"T9": "444", "T10": "555"})

    def test_replay_counts_must_not_change(self):
        logs = [{**log(fixture["id"], "duplicate_submission"), "ts": "2026-11-03T01:00:00"} for fixture in FIXTURES if fixture["id"] != "T6"]
        same = {"contacts": 5, "opportunities": 4}
        rows, summary = evaluate_replay(FIXTURES, logs, {"results": [{"id": "T6", "http_status": 400}]}, same, same)
        self.assertEqual(summary["passed"], summary["total"], problems(rows))
        rows, _ = evaluate_replay(FIXTURES, logs, {"results": [{"id": "T6", "http_status": 400}]}, same, {"contacts": 6, "opportunities": 4})
        self.assertFalse(rows[-1]["pass"])

    def test_log_helpers(self):
        logs = [{"ts": "1", "source_id": "a", "action": "created"}, {"ts": "3", "source_id": "a", "action": "duplicate_submission"}]
        self.assertEqual(find_log(logs, "a")["action"], "duplicate_submission")
        self.assertEqual(len(logs_since(logs, "2")), 1)
        self.assertEqual(safe_id("meta:900000000000010"), "meta_900000000000010")


class MetaSendTests(unittest.TestCase):
    def test_fixture_fields_map_to_real_form_keys_and_unknown_ones_drop(self):
        fields = [{"name": "full_name", "values": ["Elena"]}, {"name": "what_do_you_need_cleaned,_and_how_often?", "values": ["x"]}, {"name": "preferred_contact_time", "values": ["mornings"]}]
        mapped = map_to_form(fields, ["full_name", "email", "phone_number", "what_do_you_need_cleaned_and_how_often"])
        self.assertEqual([item["name"] for item in mapped], ["full_name", "what_do_you_need_cleaned_and_how_often"])

    def test_leadgen_event_has_the_shape_meta_sends(self):
        event = leadgen_event("123", "page1", "form9")
        change = event["entry"][0]["changes"][0]
        self.assertEqual((event["object"], change["field"], change["value"]["leadgen_id"]), ("page", "leadgen", "123"))


class CompareTests(unittest.TestCase):
    def test_three_columns_and_scores(self):
        ghl = {"generated": "2026-11-03T10:00:00", "rows": copy.deepcopy(load(REFERENCE[1][1])["rows"])}
        ghl["rows"][0]["pass"] = False
        text = render([(name, load(path)) for name, path in REFERENCE] + [("GoHighLevel", ghl)], "mock run")
        self.assertIn("| HubSpot (live OpenAI round 2, 2026-10-29) | Salesforce (live OpenAI round 1, 2026-10-30) | GoHighLevel (mock run) |", text)
        self.assertIn("| T1 | Qualified form inquiry | PASS | PASS | FAIL |", text)
        self.assertIn("HubSpot 8 / 8, Salesforce 8 / 8, GoHighLevel 7 / 8.", text)
        self.assertNotIn("T9 |", text)


if __name__ == "__main__":
    unittest.main()
