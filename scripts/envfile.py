import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFIXES = ("GHL_", "META_", "MOCK_", "GMAIL_", "OPENAI_", "SLACK_", "LLM_", "N8N_", "GENERIC_", "REPLY_", "DEMO_")


def load_env(path=ROOT / ".env"):
    values = {}
    env_path = Path(path)
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            values[key.strip()] = value.strip()
    for key, value in os.environ.items():
        if key in values or key.startswith(PREFIXES):
            values[key] = value
    return values


def require(values, name):
    if not values.get(name):
        raise SystemExit(f"Missing {name} in .env")
    return values[name]


def mask(text, values):
    """Replace every secret value that appears in text with ***."""
    text = str(text)
    for name in ("GHL_TOKEN", "META_APP_SECRET", "META_PAGE_TOKEN", "META_USER_TOKEN", "META_VERIFY_TOKEN", "OPENAI_API_KEY", "GMAIL_APP_PASSWORD", "SLACK_WEBHOOK_URL"):
        secret = values.get(name)
        if secret:
            text = text.replace(secret, "***").replace(secret.replace(" ", ""), "***")
    return text


GHL_API = "https://services.leadconnectorhq.com"
GRAPH_API = "https://graph.facebook.com"
# In mock runs n8n reaches the mock as http://mock:5690 inside Docker; scripts on the host use the published port.
MOCK_IN_DOCKER = "http://mock:5690"
MOCK_ON_HOST = "http://localhost:5690"


def host_url(value, default):
    url = (value or default).rstrip("/")
    return MOCK_ON_HOST if url == MOCK_IN_DOCKER else url


def is_mock(values):
    return host_url(values.get("GHL_BASE_URL"), GHL_API) == MOCK_ON_HOST


def is_meta_mock(values):
    """The Graph side can stay on the mock while GoHighLevel is real (before the Meta form exists)."""
    return host_url(values.get("META_GRAPH_URL"), GRAPH_API) == MOCK_ON_HOST
