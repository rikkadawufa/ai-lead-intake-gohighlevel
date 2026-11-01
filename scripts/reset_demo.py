"""Remove demo contacts (@example.com / @example.org, or no email and a 555-01xx phone) with their opportunities,
then clear local run output. Notes and tasks go with the contact.

Dry run by default; pass --apply to delete. output/ghl-ids.json is kept.
"""
import argparse
import json
import shutil

try:
    from .demo_common import IDS_PATH, OUTPUT, fixture_email, load_fixtures
    from .ghl_client import is_demo_contact
    from .ghl_setup import client_from_env
except ImportError:
    from demo_common import IDS_PATH, OUTPUT, fixture_email, load_fixtures
    from ghl_client import is_demo_contact
    from ghl_setup import client_from_env

LOCAL_DIRS = ("run-log", "review")


def reset(client, apply=False, output=OUTPUT, ids_path=IDS_PATH, fixtures=None):
    fixtures = load_fixtures()[0] if fixtures is None else fixtures
    emails = sorted({email for email in (fixture_email(item, fixtures) for item in fixtures) if email})
    pipeline_id = json.loads(ids_path.read_text(encoding="utf-8"))["pipelineId"] if ids_path.exists() else None
    contacts = [item for item in client.demo_contacts(emails) if is_demo_contact(item)]
    plan = []
    for contact in contacts:
        opportunities = client.opportunities(contact["id"], pipeline_id, status="all") if pipeline_id else []
        plan.append({"id": contact["id"], "email": contact.get("email") or contact.get("phone"), "opportunities": [item["id"] for item in opportunities]})
    if apply:
        for item in plan:
            # Deleted explicitly first in case GoHighLevel keeps them when the contact goes.
            for opportunity_id in item["opportunities"]:
                client.delete_opportunity(opportunity_id)
            client.delete_contact(item["id"])
    local = [name for name in LOCAL_DIRS if (output / name).exists()] + [path.name for path in output.glob("send-log-*.json")] + [path.name for path in output.glob("results*.*")]
    if apply:
        for name in LOCAL_DIRS:
            shutil.rmtree(output / name, ignore_errors=True)
        for pattern in ("send-log-*.json", "results*.*"):
            for path in output.glob(pattern):
                path.unlink()
    return {"applied": apply, "contacts": plan, "local": local}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    result = reset(client_from_env(), apply=args.apply)
    verb = "Deleted" if result["applied"] else "Would delete"
    print(f"{verb} {len(result['contacts'])} demo contacts and {sum(len(item['opportunities']) for item in result['contacts'])} opportunities.")
    for item in result["contacts"]:
        print(f"  {item['email']} (id {item['id']}, {len(item['opportunities'])} opportunities)")
    print(f"{'Cleared' if result['applied'] else 'Would clear'} local output: {', '.join(result['local']) or 'nothing'}")


if __name__ == "__main__":
    main()
