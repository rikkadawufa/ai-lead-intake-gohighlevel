"""Forward only the Meta lead webhook from the public tunnel to the local n8n.

The tunnel points at this relay (port 5691), not at n8n, so the n8n editor, the review page and the
other webhooks stay on localhost. GET (subscription check) and POST (leads, raw body and signature
header kept as they are) on /webhook/meta-leads are passed through; everything else gets a 404.

  python scripts/meta_relay.py
  ngrok http 5691   (or: cloudflared tunnel --url http://localhost:5691)
"""
import http.server
import urllib.error
import urllib.request

PATH = "/webhook/meta-leads"
N8N = "http://localhost:5681"
PASS_HEADERS = ("content-type", "x-hub-signature-256", "x-hub-signature")


def forward(method, path_and_query, headers, body):
    request = urllib.request.Request(N8N + path_and_query, data=body, method=method, headers={key: value for key, value in headers.items() if key.lower() in PASS_HEADERS})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read(), response.headers.get("Content-Type", "text/plain")
    except urllib.error.HTTPError as error:
        return error.code, error.read(), error.headers.get("Content-Type", "text/plain")
    except urllib.error.URLError:
        return 502, b"n8n is not reachable", "text/plain"


class Relay(http.server.BaseHTTPRequestHandler):
    def _handle(self, method):
        if self.path.split("?", 1)[0] != PATH:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        status, payload, content_type = forward(method, self.path, dict(self.headers), body)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def log_message(self, fmt, *args):
        # The verify token is in the GET query string; log only the method, path and status.
        print(f"{self.command} {self.path.split('?', 1)[0]} {args[1] if len(args) > 1 else ''}")


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 5691), Relay)
    print(f"Relaying {PATH} from http://localhost:5691 to {N8N}. Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
