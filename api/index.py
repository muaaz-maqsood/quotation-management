"""
Vercel serverless entrypoint for the TMC Quote web app.

Re-uses the route table defined in ../server.py so that every /api/* endpoint
behaves identically to the local stdlib HTTP server.

Required Vercel environment variables (Project Settings -> Environment Variables):
    ODOO_URL    e.g. https://demo.tallymarkscloud.com:8046
    ODOO_DB     e.g. TMC_Prod_Ess
    ODOO_USER   e.g. admin
    ODOO_PASS   e.g. admin
"""

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

# Make the repository root importable so we can pull in server.py.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from server import ROUTES  # noqa: E402  (import after sys.path tweak)
import server as _server  # noqa: E402


def _api_config(_body):
    """Diagnostic endpoint: returns the env-var config the function is using.
    Password is masked. Use this to verify Vercel env vars are set correctly.
    """
    pw = _server.ODOO_PASS or ""
    return {
        "ok": True,
        "odoo_url": _server.ODOO_URL,
        "odoo_db": _server.ODOO_DB,
        "odoo_user": _server.ODOO_USER,
        "odoo_pass_set": bool(pw),
        "odoo_pass_len": len(pw),
        "env_vars_present": {
            "ODOO_URL": "ODOO_URL" in os.environ,
            "ODOO_DB": "ODOO_DB" in os.environ,
            "ODOO_USER": "ODOO_USER" in os.environ,
            "ODOO_PASS": "ODOO_PASS" in os.environ,
        },
    }


# Register the diagnostic route (only inside the Vercel function — does not
# affect the local server.py route table at runtime since this module is
# loaded only on Vercel).
ROUTES["/api/config"] = _api_config


class handler(BaseHTTPRequestHandler):  # noqa: N801  (Vercel requires lowercase `handler`)
    def _json(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length).decode("utf-8") or "{}"
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def _dispatch(self):
        parsed = urlparse(self.path)
        path = parsed.path
        route = ROUTES.get(path)
        if not route and not path.startswith("/api/"):
            route = ROUTES.get("/api" + path)
        if not route:
            self._json(404, {"ok": False, "error": f"no route {path}"})
            return
        try:
            if self.command == "POST":
                body = self._read_body()
            else:
                qs = parse_qs(parsed.query)
                body = {
                    k: (v[0] if isinstance(v, list) and v else v)
                    for k, v in qs.items()
                }
            result = route(body)
            self._json(200, result)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            err = str(exc)
            hint = None
            low = err.lower()
            if "connection refused" in low or "errno 111" in low or "errno -2" in low or "name or service" in low:
                hint = (
                    "Cannot reach Odoo. Verify ODOO_URL/ODOO_DB/ODOO_USER/ODOO_PASS "
                    "are set in Vercel Project Settings -> Environment Variables, "
                    "and that the Odoo host is publicly reachable from the internet. "
                    f"Current ODOO_URL={_server.ODOO_URL!r}"
                )
            self._json(500, {"ok": False, "error": err, "hint": hint})

    def do_GET(self):  # noqa: N802
        self._dispatch()

    def do_POST(self):  # noqa: N802
        self._dispatch()

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[tmc-web] {self.address_string()} - {fmt % args}\n")
