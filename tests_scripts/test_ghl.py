import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path

from scripts.envfile import host_url, is_meta_mock, is_mock, mask
from scripts.ghl_client import GHL, GHLError, is_demo_contact
from scripts.ghl_setup import FIELDS, STAGES, setup
from scripts.reset_demo import reset

TOKEN = "pit-1234-secret"
PIPELINE = {"id": "p1", "name": "Inquiries", "stages": [{"id": f"s{index}", "name": name} for index, name in enumerate(STAGES)]}


class FakeTransport:
    """Routes (method, path fragment) to a list of responses; the last response repeats."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, headers, body))
        path = urllib.parse.unquote_plus(url.split("leadconnectorhq.com", 1)[-1])
        for key in self.routes:
            if method == key[0] and key[1] in path:
                responses = self.routes[key]
                status, payload = responses.pop(0) if len(responses) > 1 else responses[0]
                return status, payload, {}
        return 404, {"message": f"no route for {method} {path}"}, {}

    def bodies(self, method, fragment):
        return [body for call_method, url, _, body in self.calls if call_method == method and fragment in url]


def client(routes):
    transport = FakeTransport(routes)
    return GHL(TOKEN, "loc1", transport=transport, sleep=lambda seconds: None), transport


class ClientTests(unittest.TestCase):
    def test_every_call_sends_the_token_and_version_header(self):
        ghl, transport = client({("GET", "/locations/loc1"): [(200, {"location": {"id": "loc1"}})]})
        ghl.location()
        headers = transport.calls[0][2]
        self.assertEqual(headers["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual(headers["Version"], "2021-07-28")
        # Cloudflare in front of the real API answers 403 (error 1010) to urllib's default User-Agent.
        self.assertNotIn("Python-urllib", headers["User-Agent"])

    def test_retries_on_429_then_succeeds(self):
        ghl, transport = client({("GET", "/locations/loc1"): [(429, {"message": "Too many requests"}), (200, {"location": {"id": "loc1"}})]})
        self.assertEqual(ghl.location()["id"], "loc1")
        self.assertEqual(len(transport.calls), 2)

    def test_errors_never_contain_the_token(self):
        ghl, _ = client({("GET", "/locations/loc1"): [(401, {"message": f"Invalid token {TOKEN}"})]})
        with self.assertRaises(GHLError) as caught:
            ghl.location()
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertIn("scopes", str(caught.exception))
        self.assertEqual(mask(f"x {TOKEN} y", {"GHL_TOKEN": TOKEN}), "x *** y")

    def test_demo_contacts_are_only_reserved_domains_or_fictional_phones(self):
        self.assertTrue(is_demo_contact({"email": "dana@example.com"}))
        self.assertTrue(is_demo_contact({"email": None, "phone": "+15105550142"}))
        self.assertFalse(is_demo_contact({"email": "owner@gmail.com"}))
        self.assertFalse(is_demo_contact({"email": None, "phone": "+15105551234"}))

    def test_mock_urls_are_translated_for_host_scripts(self):
        self.assertEqual(host_url("http://mock:5690", "x"), "http://localhost:5690")
        self.assertEqual(host_url("", "https://services.leadconnectorhq.com"), "https://services.leadconnectorhq.com")
        self.assertTrue(is_mock({"GHL_BASE_URL": "http://mock:5690"}))
        self.assertFalse(is_mock({}))

    def test_meta_can_stay_on_the_mock_while_gohighlevel_is_real(self):
        values = {"GHL_BASE_URL": "", "META_GRAPH_URL": "http://mock:5690"}
        self.assertFalse(is_mock(values))
        self.assertTrue(is_meta_mock(values))
        self.assertFalse(is_meta_mock({"META_GRAPH_URL": ""}))


class SetupTests(unittest.TestCase):
    def routes(self, existing):
        return {
            ("GET", "/locations/loc1/customFields"): [(200, {"customFields": existing})],
            ("POST", "/locations/loc1/customFields"): [(201, {"customField": {"id": "new"}})],
            ("GET", "/locations/loc1"): [(200, {"location": {"name": "Tidewell (demo)", "timezone": "America/Los_Angeles"}})],
            ("GET", "/opportunities/pipelines"): [(200, {"pipelines": [PIPELINE]})],
        }

    def test_creates_only_missing_fields_and_writes_ids(self):
        existing = [{"id": "f1", "name": "Lead Tier", "fieldKey": "contact.lead_tier", "dataType": "SINGLE_OPTIONS", "picklistOptions": ["qualified", "needs_review", "not_qualified"]}]
        ghl, transport = client(self.routes(existing))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "ghl-ids.json"
            result = setup(ghl, ids_path=path)
            ids = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(result["skipped"], ["Lead Tier"])
        self.assertEqual(len(result["created"]), len(FIELDS) - 1)
        self.assertEqual(ids["fields"]["lead_tier"], "f1")
        self.assertEqual(ids["stages"]["New – qualified"], "s0")
        self.assertEqual(ids["timezone"], "America/Los_Angeles")
        created = transport.bodies("POST", "/customFields")
        self.assertEqual({body["name"] for body in created}, {name for _, name, _, _ in FIELDS[1:]})
        self.assertTrue(all(body["model"] == "contact" for body in created))
        self.assertIn("meta_lead", next(body for body in created if body["name"] == "Inquiry Source")["options"])

    def test_dry_run_writes_nothing(self):
        ghl, transport = client(self.routes([]))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "ghl-ids.json"
            setup(ghl, dry_run=True, ids_path=path)
            self.assertFalse(path.exists())
        self.assertEqual(transport.bodies("POST", "/customFields"), [])

    def test_existing_field_missing_an_option_is_reported(self):
        existing = [{"id": "f4", "name": "Inquiry Source", "dataType": "SINGLE_OPTIONS", "picklistOptions": ["form", "email"]}]
        ghl, _ = client(self.routes(existing))
        with tempfile.TemporaryDirectory() as folder:
            result = setup(ghl, ids_path=Path(folder) / "ids.json")
        self.assertTrue(any("meta_lead" in problem for problem in result["problems"]))

    def test_missing_pipeline_stops_with_instructions(self):
        routes = self.routes([])
        routes[("GET", "/opportunities/pipelines")] = [(200, {"pipelines": []})]
        ghl, _ = client(routes)
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(SystemExit) as caught:
            setup(ghl, ids_path=Path(folder) / "ids.json")
        self.assertIn("Opportunities → Pipelines", str(caught.exception))


class ResetTests(unittest.TestCase):
    def test_deletes_only_demo_contacts_and_their_opportunities(self):
        contacts = [{"id": "c1", "email": "dana.whitfield@example.com"}, {"id": "c2", "email": "owner@gmail.com"}, {"id": "c3", "email": None, "phone": "+15105550142"}]
        ghl, transport = client({
            ("POST", "/contacts/search"): [(200, {"contacts": contacts})],
            ("GET", "/contacts/search/duplicate"): [(200, {"contact": None})],
            ("GET", "/opportunities/search"): [(200, {"opportunities": [{"id": "o1"}]})],
            ("DELETE", "/opportunities/"): [(200, {})],
            ("DELETE", "/contacts/"): [(200, {})],
        })
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)
            (output / "run-log").mkdir()
            ids = output / "ghl-ids.json"
            ids.write_text(json.dumps({"pipelineId": "p1"}), encoding="utf-8")
            result = reset(ghl, apply=True, output=output, ids_path=ids, fixtures=[])
            self.assertFalse((output / "run-log").exists())
            self.assertTrue(ids.exists())
        self.assertEqual(sorted(item["id"] for item in result["contacts"]), ["c1", "c3"])
        deleted = [url for method, url, _, _ in transport.calls if method == "DELETE"]
        self.assertFalse(any("/contacts/c2" in url for url in deleted))
        self.assertEqual(sum("/opportunities/o1" in url for url in deleted), 2)

    def test_dry_run_deletes_nothing(self):
        ghl, transport = client({("POST", "/contacts/search"): [(200, {"contacts": [{"id": "c1", "email": "a@example.com"}]})], ("GET", "/contacts/search/duplicate"): [(200, {})]})
        with tempfile.TemporaryDirectory() as folder:
            reset(ghl, apply=False, output=Path(folder), ids_path=Path(folder) / "none.json", fixtures=[])
        self.assertFalse(any(method == "DELETE" for method, *_ in transport.calls))


if __name__ == "__main__":
    unittest.main()
