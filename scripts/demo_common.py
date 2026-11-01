"""Paths and helpers shared by the fixture, reset and results scripts."""
import json
import re
from pathlib import Path

try:
    from .envfile import ROOT
except ImportError:
    from envfile import ROOT

FIXTURES_PATH = ROOT / "sample-data" / "fixtures.json"
OUTPUT = ROOT / "output"
RUN_LOG_DIR = OUTPUT / "run-log"
REVIEW_DIR = OUTPUT / "review"
N8N_URL = "http://localhost:5681"
FORM_URL = f"{N8N_URL}/webhook/inquiry"
META_WEBHOOK_URL = f"{N8N_URL}/webhook/meta-leads"
IDS_PATH = OUTPUT / "ghl-ids.json"


def load_fixtures(path=FIXTURES_PATH):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return data["fixtures"], data.get("reviews", [])


def by_id(fixtures):
    return {fixture["id"]: fixture for fixture in fixtures}


def base_fixture(fixture, fixtures):
    return by_id(fixtures)[fixture["resend_of"]] if fixture.get("resend_of") else fixture


def source_id(fixture, fixtures, leadgen_ids=None):
    """Meta assigns leadgen ids in live runs; pass the ones seen in the run log as {fixture_id: leadgen_id}."""
    base = base_fixture(fixture, fixtures)
    if base["channel"] == "form":
        return f"form:{base['submission_id']}"
    if base["channel"] == "email":
        return f"email:{base['message_id']}"
    leadgen = (leadgen_ids or {}).get(base["id"]) or base.get("mock_leadgen_id")
    return f"meta:{leadgen}"


def fixture_email(fixture, fixtures):
    base = base_fixture(fixture, fixtures)
    return (base.get("payload") or {}).get("email") or (base.get("field_data") or {}).get("email") or base.get("reply_to") or None


def safe_id(value):
    """Same rule as safeId() in n8n-src/code/review.js."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_", str(value or "unknown")).strip("_")[:80]


def read_json_files(folder, pattern="*.json"):
    folder = Path(folder)
    if not folder.exists():
        return []
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(folder.glob(pattern))]
