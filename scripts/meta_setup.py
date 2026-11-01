"""Connect the development-mode Meta app and the test Page to the n8n lead webhook.

  python scripts/meta_setup.py token        # META_USER_TOKEN (short-lived, from Graph API Explorer) → long-lived Page token, written to .env
  python scripts/meta_setup.py forms        # list the Page's lead forms and their question keys
  python scripts/meta_setup.py subscribe --callback https://<tunnel-host>
                                            # subscribe the Page to leadgen and point the app's webhook at the tunnel
Nothing secret is printed. Meta calls the callback right away to verify it, so the relay and tunnel must be running.
"""
import argparse
import json
import re
import urllib.error
import urllib.parse
import urllib.request

try:
    from .envfile import GRAPH_API, ROOT, host_url, load_env, mask, require
except ImportError:
    from envfile import GRAPH_API, ROOT, host_url, load_env, mask, require

GRAPH_VERSION = "v21.0"


def graph(values, method, path, params):
    base = host_url(values.get("META_GRAPH_URL"), GRAPH_API)
    query = urllib.parse.urlencode(params)
    data = None
    url = f"{base}/{GRAPH_VERSION}{path}"
    if method == "GET":
        url = f"{url}?{query}"
    else:
        data = query.encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as error:
        payload = error.read().decode("utf-8", "replace")
        raise SystemExit(f"Graph API {error.code} on {path}: {mask(payload[:400], values)}")


def set_env_value(name, value, path=ROOT / ".env"):
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    line = f"{name}={value}"
    text = re.sub(rf"^{name}=.*$", line, text, flags=re.M) if re.search(rf"^{name}=", text, flags=re.M) else text.rstrip("\n") + f"\n{line}\n"
    path.write_text(text, encoding="utf-8")


def long_lived_page_token(values):
    app_id, secret = require(values, "META_APP_ID"), require(values, "META_APP_SECRET")
    user = graph(values, "GET", "/oauth/access_token", {"grant_type": "fb_exchange_token", "client_id": app_id, "client_secret": secret, "fb_exchange_token": require(values, "META_USER_TOKEN")})
    # A Page token read with a long-lived user token does not expire.
    page = graph(values, "GET", f"/{require(values, 'META_PAGE_ID')}", {"fields": "name,access_token", "access_token": user["access_token"]})
    if not page.get("access_token"):
        raise SystemExit("No Page token came back. Check that the user token was granted this Page and pages_show_list.")
    return page


def forms(values):
    payload = graph(values, "GET", f"/{require(values, 'META_PAGE_ID')}/leadgen_forms", {"fields": "id,name,status,questions", "access_token": require(values, "META_PAGE_TOKEN")})
    return payload.get("data", [])


def subscribe(values, callback):
    page_id, token = require(values, "META_PAGE_ID"), require(values, "META_PAGE_TOKEN")
    app_id, secret = require(values, "META_APP_ID"), require(values, "META_APP_SECRET")
    callback_url = callback.rstrip("/") + "/webhook/meta-leads"
    app = graph(values, "POST", f"/{app_id}/subscriptions", {"object": "page", "callback_url": callback_url, "fields": "leadgen", "verify_token": require(values, "META_VERIFY_TOKEN"), "include_values": "true", "access_token": f"{app_id}|{secret}"})
    page = graph(values, "POST", f"/{page_id}/subscribed_apps", {"subscribed_fields": "leadgen", "access_token": token})
    return {"callback": callback_url, "app_subscription": app.get("success"), "page_subscription": page.get("success")}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["token", "forms", "subscribe"])
    parser.add_argument("--callback", help="public HTTPS base URL of the tunnel (subscribe only)")
    args = parser.parse_args()
    values = load_env()
    if args.command == "token":
        page = long_lived_page_token(values)
        set_env_value("META_PAGE_TOKEN", page["access_token"])
        print(f"Wrote a long-lived Page token for {page.get('name')} to .env (META_PAGE_TOKEN). You can delete META_USER_TOKEN now.")
    elif args.command == "forms":
        for form in forms(values):
            keys = ", ".join(item.get("key", "") for item in form.get("questions", []))
            print(f"{form['id']}  {form.get('name')}  ({form.get('status')})\n    questions: {keys}")
    else:
        if not args.callback or not args.callback.startswith("https://"):
            raise SystemExit("Pass --callback https://<tunnel host> (Meta only calls HTTPS URLs).")
        print(json.dumps(subscribe(values, args.callback), indent=2))


if __name__ == "__main__":
    main()
