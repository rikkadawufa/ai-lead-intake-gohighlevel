"""Small GoHighLevel API v2 client (stdlib only) shared by the demo scripts.

Auth is a sub-account Private Integration Token sent as a bearer token, plus the Version header every call needs.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request

API_VERSION = "2021-07-28"
DEMO_DOMAINS = ("@example.com", "@example.org")
RETRY_STATUSES = (429, 500, 502, 503, 504)
# Cloudflare in front of the API refuses urllib's default User-Agent (error 1010).
USER_AGENT = "lead-intake-ghl-demo/1.0"


class GHLError(Exception):
    def __init__(self, status, message):
        super().__init__(f"GoHighLevel API {status}: {message}")
        self.status = status


def urllib_transport(method, url, headers, body):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else {}, dict(response.headers)
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"message": raw[:300]}
        return error.code, payload, dict(error.headers or {})


def is_demo_email(email):
    return bool(email) and email.lower().endswith(DEMO_DOMAINS)


def is_demo_phone(e164):
    """Fictional US range 555-0100 to 555-0199, used for phone-only demo inquiries."""
    value = str(e164 or "")
    return len(value) == 12 and value.startswith("+1") and value[5:10] == "55501" and value[2:].isdigit()


def is_demo_contact(contact):
    return is_demo_email(contact.get("email")) or (not contact.get("email") and is_demo_phone(contact.get("phone")))


def error_text(payload):
    if isinstance(payload, dict):
        message = payload.get("message") or payload.get("error") or payload
        return json.dumps(message)[:300] if not isinstance(message, str) else message[:300]
    return str(payload)[:300]


class GHL:
    def __init__(self, token, location_id, base_url="https://services.leadconnectorhq.com", transport=urllib_transport, sleep=time.sleep):
        self.base_url = base_url.rstrip("/")
        self.location_id = location_id
        self._token = token
        self._transport = transport
        self._sleep = sleep

    def _mask(self, text):
        return str(text).replace(self._token, "***") if self._token else str(text)

    def request(self, method, path, body=None, ok=(200, 201), allow=()):
        headers = {"Authorization": f"Bearer {self._token}", "Version": API_VERSION, "Accept": "application/json", "User-Agent": USER_AGENT}
        if body is not None:
            headers["Content-Type"] = "application/json"
        attempt = 0
        while True:
            status, payload, response_headers = self._transport(method, self.base_url + path, headers, body)
            if status in RETRY_STATUSES and attempt < 3:
                attempt += 1
                retry_after = str((response_headers or {}).get("Retry-After") or (response_headers or {}).get("retry-after") or "")
                self._sleep(float(retry_after) if retry_after.replace(".", "", 1).isdigit() else 2 * attempt)
                continue
            break
        if status in ok or status in allow:
            return status, payload
        message = error_text(payload)
        if status in (401, 403):
            message = f"{message} (check GHL_TOKEN and the Private Integration's scopes)"
        raise GHLError(status, self._mask(message))

    def _q(self, **params):
        return urllib.parse.urlencode({key: value for key, value in params.items() if value is not None})

    # Location setup
    def location(self):
        return self.request("GET", f"/locations/{self.location_id}")[1].get("location", {})

    def custom_fields(self):
        return self.request("GET", f"/locations/{self.location_id}/customFields")[1].get("customFields", [])

    def create_custom_field(self, body):
        return self.request("POST", f"/locations/{self.location_id}/customFields", body)[1].get("customField", {})

    def pipelines(self):
        return self.request("GET", f"/opportunities/pipelines?{self._q(locationId=self.location_id)}")[1].get("pipelines", [])

    # Contacts
    def find_duplicate(self, email=None, phone=None):
        payload = self.request("GET", f"/contacts/search/duplicate?{self._q(locationId=self.location_id, email=email, number=phone)}")[1]
        return payload.get("contact") or None

    def get_contact(self, contact_id):
        return self.request("GET", f"/contacts/{contact_id}")[1].get("contact", {})

    def search_contacts(self, query, page_limit=100):
        payload = self.request("POST", "/contacts/search", {"locationId": self.location_id, "pageLimit": page_limit, "query": query})[1]
        return payload.get("contacts", [])

    def delete_contact(self, contact_id):
        self.request("DELETE", f"/contacts/{contact_id}", allow=(404,))

    def notes(self, contact_id):
        return self.request("GET", f"/contacts/{contact_id}/notes")[1].get("notes", [])

    def tasks(self, contact_id):
        return self.request("GET", f"/contacts/{contact_id}/tasks")[1].get("tasks", [])

    # Opportunities
    def opportunities(self, contact_id, pipeline_id, status=None):
        query = self._q(location_id=self.location_id, contact_id=contact_id, pipeline_id=pipeline_id, status=status)
        return self.request("GET", f"/opportunities/search?{query}")[1].get("opportunities", [])

    def delete_opportunity(self, opportunity_id):
        self.request("DELETE", f"/opportunities/{opportunity_id}", allow=(404,))

    def demo_contacts(self, emails=()):
        """Demo contacts found by searching the demo domains, plus a duplicate lookup for each known fixture email."""
        found = {}
        for query in ("example.com", "example.org"):
            for contact in self.search_contacts(query):
                found[contact["id"]] = contact
        for email in emails:
            contact = self.find_duplicate(email=email)
            if contact:
                found[contact["id"]] = contact
        return [contact for contact in found.values() if is_demo_contact(contact)]
