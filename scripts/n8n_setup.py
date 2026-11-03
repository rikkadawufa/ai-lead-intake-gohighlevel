"""Import credentials and generated workflows into the local n8n, then publish them.

Secrets go from .env into a temp file, are copied into the container for the import
and deleted on both sides right after. Nothing secret is printed.
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

try:
    from .envfile import ROOT, load_env, mask, require
except ImportError:
    from envfile import ROOT, load_env, mask, require

WORKFLOW_IDS = ["wfErrorHandler", "wfProcessInquiry", "wfReviewPage", "wfFormIntake", "wfEmailIntake", "wfMetaLeadIntake"]


def credentials(values):
    creds = [
        {"id": "ghlTokenCred01", "name": "GoHighLevel (private integration)", "type": "httpHeaderAuth",
         "data": {"name": "Authorization", "value": f"Bearer {require(values, 'GHL_TOKEN')}"}},
        # Sent by n8n as ?access_token=… on the Graph lead read.
        {"id": "metaPageCred01", "name": "Meta Page token", "type": "httpQueryAuth",
         "data": {"name": "access_token", "value": require(values, "META_PAGE_TOKEN")}},
        {"id": "openAiCred01", "name": "OpenAI", "type": "httpHeaderAuth",
         "data": {"name": "Authorization", "value": f"Bearer {require(values, 'OPENAI_API_KEY')}"}},
        # The review page and its form post are public webhooks once n8n is reachable, so both ask for this login.
        {"id": "reviewLoginCred01", "name": "Review page login", "type": "httpBasicAuth",
         "data": {"user": require(values, "REVIEW_USER"), "password": require(values, "REVIEW_PASSWORD")}},
    ]
    # A mock run can go without Gmail: the email intake is then not published and nothing can be sent.
    if values.get("GMAIL_ADDRESS"):
        gmail_password = require(values, "GMAIL_APP_PASSWORD").replace(" ", "")
        gmail = values["GMAIL_ADDRESS"]
        creds += [
            {"id": "gmailImapCred01", "name": "Gmail IMAP (demo inbox)", "type": "imap",
             "data": {"user": gmail, "password": gmail_password, "host": "imap.gmail.com", "port": 993, "secure": True, "allowUnauthorizedCerts": False}},
            {"id": "gmailSmtpCred01", "name": "Gmail SMTP (demo inbox)", "type": "smtp",
             "data": {"user": gmail, "password": gmail_password, "host": "smtp.gmail.com", "port": 465, "secure": True, "disableStartTls": False, "hostName": ""}},
        ]
    return creds


def run(command, values):
    result = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        raise SystemExit(f"Command failed: {' '.join(command[:4])}…\n{mask(result.stderr[-800:], values)}")
    return result.stdout


def import_credentials(values):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
        local_path = Path(handle.name)
        creds = credentials(values)
        json.dump(creds, handle)
    container_path = "/tmp/lead-intake-credentials.json"
    try:
        run(["docker", "compose", "cp", str(local_path), f"n8n:{container_path}"], values)
        run(["docker", "compose", "exec", "-T", "n8n", "n8n", "import:credentials", "--input", container_path], values)
    finally:
        local_path.unlink(missing_ok=True)
        subprocess.run(["docker", "compose", "exec", "-T", "-u", "root", "n8n", "rm", "-f", container_path], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return len(creds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-credentials", action="store_true", help="only re-import and publish workflows")
    parser.add_argument("--no-publish", action="store_true")
    args = parser.parse_args()
    values = load_env()
    if not args.skip_credentials:
        print(f"Imported {import_credentials(values)} credentials.")
    run(["docker", "compose", "exec", "-T", "n8n", "n8n", "import:workflow", "--separate", "--input=/files/workflows/"], values)
    print(f"Imported {len(WORKFLOW_IDS)} workflows.")
    if args.no_publish:
        return
    published = [item for item in WORKFLOW_IDS if values.get("GMAIL_ADDRESS") or item != "wfEmailIntake"]
    for workflow_id in published:
        run(["docker", "compose", "exec", "-T", "n8n", "n8n", "publish:workflow", f"--id={workflow_id}"], values)
    run(["docker", "compose", "restart", "n8n"], values)
    print("Published all workflows and restarted n8n (webhooks take a few seconds to register).")


if __name__ == "__main__":
    main()
