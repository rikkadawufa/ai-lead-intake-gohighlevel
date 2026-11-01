"""Create the lead intake custom fields in the GoHighLevel sub-account, find the Inquiries pipeline,
and write every id the workflows need to output/ghl-ids.json (safe to rerun).

The pipeline and its stages are created by hand in GoHighLevel (Opportunities → Pipelines); this script only reads them.
"""
import argparse
import json

try:
    from .demo_common import IDS_PATH
    from .envfile import GHL_API, host_url, load_env, require
    from .ghl_client import GHL
except ImportError:
    from demo_common import IDS_PATH
    from envfile import GHL_API, host_url, load_env, require
    from ghl_client import GHL

TIERS = ["qualified", "needs_review", "not_qualified"]
TOPICS = ["regular_cleaning", "deep_cleaning", "quote_request", "complaint", "job_application", "sales_pitch", "other"]
URGENCIES = ["high", "normal", "low"]
SOURCES = ["form", "email", "meta_lead"]

# (key used by the workflows, field name in GoHighLevel, dataType, options)
FIELDS = [
    ("lead_tier", "Lead Tier", "SINGLE_OPTIONS", TIERS),
    ("inquiry_topic", "Inquiry Topic", "SINGLE_OPTIONS", TOPICS),
    ("inquiry_urgency", "Inquiry Urgency", "SINGLE_OPTIONS", URGENCIES),
    ("inquiry_source", "Inquiry Source", "SINGLE_OPTIONS", SOURCES),
    ("ai_reason", "AI Reason", "LARGE_TEXT", None),
    ("inquiry_source_ids", "Inquiry Source IDs", "LARGE_TEXT", None),
]
PIPELINE = "Inquiries"
STAGES = ["New – qualified", "Needs review", "Contacted", "Won", "Lost"]


def client_from_env(values=None):
    values = values or load_env()
    return GHL(require(values, "GHL_TOKEN"), require(values, "GHL_LOCATION_ID"), host_url(values.get("GHL_BASE_URL"), GHL_API))


def normalized(text):
    return "".join(ch for ch in str(text).lower().replace("–", "-") if ch.isalnum())


def find_field(existing, key, name):
    for field in existing:
        if field.get("fieldKey") in (f"contact.{key}", key) or normalized(field.get("name")) == normalized(name):
            return field
    return None


def ensure_fields(client, dry_run):
    existing = client.custom_fields()
    ids, created, skipped, problems = {}, [], [], []
    for key, name, data_type, options in FIELDS:
        field = find_field(existing, key, name)
        if field:
            skipped.append(name)
            ids[key] = field["id"]
            if field.get("dataType") and field["dataType"] != data_type:
                problems.append(f"{name} exists as {field['dataType']}, expected {data_type}")
            missing = sorted(set(options or []) - set(field.get("picklistOptions") or options or []))
            if missing:
                problems.append(f"{name} is missing options: {', '.join(missing)} (add them in GoHighLevel → Settings → Custom Fields)")
            continue
        created.append(name)
        if not dry_run:
            body = {"name": name, "dataType": data_type, "model": "contact"}
            if options:
                body["options"] = options
            ids[key] = client.create_custom_field(body)["id"]
    return ids, created, skipped, problems


def find_pipeline(client):
    pipelines = client.pipelines()
    pipeline = next((item for item in pipelines if normalized(item.get("name")) == normalized(PIPELINE)), None)
    if not pipeline:
        raise SystemExit(f"No pipeline named {PIPELINE!r}. Create it in GoHighLevel → Opportunities → Pipelines with stages: {', '.join(STAGES)}.")
    stages = {}
    for name in STAGES:
        stage = next((item for item in pipeline.get("stages", []) if normalized(item.get("name")) == normalized(name)), None)
        if not stage:
            raise SystemExit(f"Pipeline {PIPELINE!r} has no stage {name!r}. Stages found: {', '.join(item.get('name', '') for item in pipeline.get('stages', []))}")
        stages[name] = stage["id"]
    return pipeline["id"], stages


def setup(client, dry_run=False, ids_path=IDS_PATH):
    location = client.location()
    fields, created, skipped, problems = ensure_fields(client, dry_run)
    pipeline_id, stages = find_pipeline(client)
    ids = {"locationId": client.location_id, "timezone": location.get("timezone") or "America/Los_Angeles", "fields": fields, "pipelineId": pipeline_id, "stages": stages}
    if not dry_run:
        ids_path.parent.mkdir(parents=True, exist_ok=True)
        ids_path.write_text(json.dumps(ids, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"location": location.get("name"), "created": created, "skipped": skipped, "problems": problems, "ids": ids}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="only list what would be created")
    args = parser.parse_args()
    result = setup(client_from_env(), dry_run=args.dry_run)
    verb = "Would create" if args.dry_run else "Created"
    print(f"Location: {result['location']} ({result['ids']['locationId']}, {result['ids']['timezone']})")
    print(f"{verb} fields: {', '.join(result['created']) or 'none'}; already there: {', '.join(result['skipped']) or 'none'}")
    print(f"Pipeline {PIPELINE}: {len(result['ids']['stages'])} stages found")
    for problem in result["problems"]:
        print(f"  ! {problem}")
    if not args.dry_run:
        print(f"Wrote {IDS_PATH.name}")


if __name__ == "__main__":
    main()
