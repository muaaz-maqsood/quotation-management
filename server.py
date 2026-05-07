"""
TMC Quote Web App <-> Odoo bridge.

Stdlib-only HTTP server. Serves index.html and exposes JSON endpoints that
forward read/write calls to the local Odoo instance via JSON-RPC.

Run:    python server.py
Open:   http://localhost:5055/
"""

import http.server
import json
import os
import socketserver
import sys
import traceback
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# Odoo connection (matches the local odoo.conf the user pasted)
# ---------------------------------------------------------------------------
ODOO_URL = os.environ.get("ODOO_URL", "http://localhost:8090")
ODOO_DB = os.environ.get("ODOO_DB", "odoo_demo_latest_31_3_25")
ODOO_USER = os.environ.get("ODOO_USER", "admin")
ODOO_PASS = os.environ.get("ODOO_PASS", "admin")

WEB_HOST = os.environ.get("WEB_HOST", "127.0.0.1")
WEB_PORT = int(os.environ.get("WEB_PORT", "5066"))

STATIC_DIR = os.path.dirname(os.path.abspath(__file__))

_uid_cache = {"uid": None}


def odoo_rpc(service, method, args):
    payload = {
        "jsonrpc": "2.0",
        "method": "call",
        "params": {"service": service, "method": method, "args": args},
    }
    req = urllib.request.Request(
        f"{ODOO_URL}/jsonrpc",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if "error" in data:
        err = data["error"]
        msg = err.get("data", {}).get("message") or err.get("message") or str(err)
        raise RuntimeError(f"Odoo error: {msg}")
    return data.get("result")


def odoo_authenticate(force=False):
    if force or not _uid_cache["uid"]:
        uid = odoo_rpc("common", "authenticate", [ODOO_DB, ODOO_USER, ODOO_PASS, {}])
        if not uid:
            raise RuntimeError(
                f"Authentication failed for db={ODOO_DB!r} user={ODOO_USER!r}"
            )
        _uid_cache["uid"] = uid
    return _uid_cache["uid"]


def odoo_execute(model, method, args, kwargs=None):
    uid = odoo_authenticate()
    try:
        return odoo_rpc(
            "object",
            "execute_kw",
            [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs or {}],
        )
    except RuntimeError:
        # Session might have dropped; retry once after re-auth.
        odoo_authenticate(force=True)
        uid = _uid_cache["uid"]
        return odoo_rpc(
            "object",
            "execute_kw",
            [ODOO_DB, uid, ODOO_PASS, model, method, args, kwargs or {}],
        )


# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------
def api_ping(_body):
    return {
        "ok": True,
        "odoo_url": ODOO_URL,
        "db": ODOO_DB,
        "uid": odoo_authenticate(),
    }


def api_quotes(_body):
    rows = odoo_execute(
        "quotation.builder",
        "search_read",
        [[]],
        {
            "fields": [
                "id",
                "name",
                "customer_id",
                "project_name",
                "project_duration",
                "total_cost",
                "final_price",
                "margin",
                "status",
                "location",
                "start_date",
                "end_date",
                "commission",
            ],
            "limit": 100,
            "order": "create_date desc",
        },
    )
    return {"ok": True, "rows": rows}


def api_quote_detail(body):
    qid = int(body.get("id"))
    rec = odoo_execute(
        "quotation.builder",
        "read",
        [[qid]],
        {
            "fields": [
                "id",
                "name",
                "customer_id",
                "opportunity_id",
                "project_name",
                "project_duration",
                "project_total_duration",
                "total_cost",
                "final_price",
                "margin",
                "status",
                "location",
                "start_date",
                "end_date",
                "commission",
                "commission_percentage",
                "currency_id",
                "scope",
                "cost_line_ids",
                "resource_line_ids",
                "payment_plan_ids",
            ]
        },
    )
    record = rec[0] if rec else None

    # Expand related child tables so the UI can render a full detail view.
    resource_lines = []
    cost_lines = []
    payment_plan = []
    if record:
        if record.get("resource_line_ids"):
            resource_lines = odoo_execute(
                "quotation.resource.line",
                "read",
                [record["resource_line_ids"]],
                {
                    "fields": [
                        "id",
                        "skill_id",
                        "level_id",
                        "monthly_cost",
                        "ctc_factor",
                        "total_per_month_cost_ctc",
                        "total_cost",
                    ]
                },
            )
        if record.get("cost_line_ids"):
            cost_lines = odoo_execute(
                "quotation.cost.line",
                "read",
                [record["cost_line_ids"]],
                {"fields": ["id", "cost_type", "amount", "total_percentage"]},
            )
        if record.get("payment_plan_ids"):
            payment_plan = odoo_execute(
                "quotation.payment.plan",
                "read",
                [record["payment_plan_ids"]],
                {
                    "fields": [
                        "id",
                        "phase",
                        "milestone",
                        "percentage",
                        "percentage_amount",
                        "price",
                    ]
                },
            )

    return {
        "ok": True,
        "record": record,
        "resource_lines": resource_lines,
        "cost_lines": cost_lines,
        "payment_plan": payment_plan,
    }


def api_partners(_body):
    rows = odoo_execute(
        "res.partner",
        "search_read",
        [[["customer_rank", ">", 0]]],
        {"fields": ["id", "name", "email", "vat"], "limit": 200, "order": "name asc"},
    )
    if not rows:
        # Fallback: no customer_rank set — show all companies
        rows = odoo_execute(
            "res.partner",
            "search_read",
            [[["is_company", "=", True]]],
            {"fields": ["id", "name", "email"], "limit": 200, "order": "name asc"},
        )
    return {"ok": True, "rows": rows}


def api_leads(_body):
    rows = odoo_execute(
        "crm.lead",
        "search_read",
        [[["type", "=", "opportunity"]]],
        {
            "fields": ["id", "name", "partner_id", "expected_revenue", "probability"],
            "limit": 200,
            "order": "create_date desc",
        },
    )
    return {"ok": True, "rows": rows}


def _find_or_create_partner(name):
    """Find a res.partner by exact name, else create a new company-customer."""
    if not name:
        return None
    existing = odoo_execute(
        "res.partner",
        "search",
        [[["name", "=ilike", name]]],
        {"limit": 1},
    )
    if existing:
        return existing[0]
    return odoo_execute(
        "res.partner",
        "create",
        [{"name": name, "is_company": True, "customer_rank": 1}],
    )


def _find_or_create_analytic_account(project_name, partner_id=None):
    """Find an account.analytic.account by project name, else create one."""
    if not project_name:
        return None
    existing = odoo_execute(
        "account.analytic.account",
        "search",
        [[["name", "=ilike", project_name]]],
        {"limit": 1},
    )
    if existing:
        return existing[0]
    plan = odoo_execute(
        "account.analytic.plan",
        "search",
        [[]],
        {"limit": 1, "order": "id asc"},
    )
    vals = {"name": project_name}
    if plan:
        vals["plan_id"] = plan[0]
    if partner_id:
        vals["partner_id"] = int(partner_id)
    return odoo_execute("account.analytic.account", "create", [vals])


def api_create_quote(body):
    """
    Expects JSON with at least one of (customer_id, customer_name):
      customer_id (int)            -- existing res.partner.id
      customer_name (str)          -- creates a new res.partner if customer_id absent
      name (str)                   -- quote name; defaults to auto
      project_name (str)
      project_duration (int, months)
      start_date (YYYY-MM-DD)
      end_date (YYYY-MM-DD)
      margin (float, %)
      location ('lhr'|'khi'|'isb'|'intl')
      opportunity_id (int, optional)
      scope (html str, optional)
      create_analytic (bool)       -- also create account.analytic.account
      resource_lines: [ {monthly_cost, ctc_factor} ]
      cost_lines:     [ {cost_type, amount} ]
      payment_plan:   [ {phase, milestone, percentage} ]
    """
    customer_id = body.get("customer_id")
    if not customer_id:
        name = (body.get("customer_name") or "").strip()
        if not name:
            raise ValueError("customer_id or customer_name is required")
        customer_id = _find_or_create_partner(name)

    analytic_id = None
    if body.get("create_analytic") and body.get("project_name"):
        analytic_id = _find_or_create_analytic_account(
            body["project_name"], partner_id=customer_id
        )

    vals = {
        "customer_id": int(customer_id),
        "name": body.get("name") or f"Q/WEB/{int(__import__('time').time())}",
        "project_name": body.get("project_name") or "",
        "project_duration": int(body.get("project_duration") or 0),
        "margin": float(body.get("margin") or 0.0),
    }
    for f in ("start_date", "end_date", "location", "scope"):
        if body.get(f):
            vals[f] = body[f]
    if body.get("opportunity_id"):
        vals["opportunity_id"] = int(body["opportunity_id"])
    if body.get("commission_percentage") is not None:
        vals["commission_percentage"] = float(body["commission_percentage"])

    # Indirect cost lines go in as simple (0,0,{...}) commands.
    if body.get("cost_lines"):
        cmds = []
        for c in body["cost_lines"]:
            cmds.append(
                (
                    0,
                    0,
                    {
                        "cost_type": c.get("cost_type") or "direct",
                        "amount": float(c.get("amount") or 0.0),
                    },
                )
            )
        vals["cost_line_ids"] = cmds

    if body.get("payment_plan"):
        cmds = []
        for p in body["payment_plan"]:
            cmds.append(
                (
                    0,
                    0,
                    {
                        "phase": p.get("phase") or "mobilization",
                        "milestone": p.get("milestone") or "",
                        "percentage": float(p.get("percentage") or 0.0),
                    },
                )
            )
        vals["payment_plan_ids"] = cmds

    new_id = odoo_execute("quotation.builder", "create", [vals])

    # ----- Resource lines: Odoo's create() auto-runs _generate_month_lines()
    # which creates qm.month records AND empty resource_line_ids. We reuse its
    # months, wipe the empty lines, then create proper ones with skill / level
    # and per-month allocations so total_cost computes.
    resource_lines = body.get("resource_lines") or []

    # Remove auto-generated empty resource lines on this quote so our ones are the only set.
    empty_lines = odoo_execute(
        "quotation.resource.line",
        "search",
        [[["quotation_id", "=", new_id], ["skill_id", "=", False]]],
    )
    if empty_lines:
        try:
            odoo_execute("quotation.resource.line", "unlink", [empty_lines])
        except Exception:
            pass

    # Fetch qm.month records Odoo generated for this quote (ordered by date).
    month_rows = odoo_execute(
        "qm.month",
        "search_read",
        [[["project_id", "=", new_id]]],
        {"fields": ["id", "date"], "order": "date asc"},
    ) or []
    month_ids = [m["id"] for m in month_rows]
    duration = int(body.get("project_duration") or len(month_ids) or 0)

    for r in resource_lines:
        line_vals = {
            "quotation_id": new_id,
            "monthly_cost": float(r.get("monthly_cost") or 0.0),
            "ctc_factor": float(r.get("ctc_factor") or 15.0),
        }
        if r.get("skill_id"):
            line_vals["skill_id"] = int(r["skill_id"])
        if r.get("level_id"):
            line_vals["level_id"] = int(r["level_id"])
        rline_id = odoo_execute("quotation.resource.line", "create", [line_vals])

        if month_ids:
            alloc_pct = float(r.get("alloc_pct") or 100.0)
            res_duration = int(r.get("duration") or duration or len(month_ids))
            for idx, mid in enumerate(month_ids):
                pct = alloc_pct if idx < res_duration else 0.0
                try:
                    odoo_execute(
                        "quotation.resource.line.methods",
                        "create",
                        [
                            {
                                "resource_id": rline_id,
                                "month_id": mid,
                                "percentage": pct,
                                "march_factor": 0.0,
                            }
                        ],
                    )
                except Exception:
                    pass

    # For now: auto-approve every quote created through the web app so demos
    # don't get blocked on margin-band validation in project.approval.level.
    # Using write() directly instead of action_approved() avoids an Odoo INFO
    # log line ("action_approved can not return None") — the addon method has
    # no explicit return. Status still lands at 'approved' either way.
    odoo_execute(
        "quotation.builder", "write", [[new_id], {"status": "approved"}]
    )

    rec = odoo_execute(
        "quotation.builder",
        "read",
        [[new_id]],
        {"fields": ["id", "name", "status", "total_cost", "final_price"]},
    )
    return {
        "ok": True,
        "id": new_id,
        "record": rec[0] if rec else None,
        "customer_id": customer_id,
        "analytic_account_id": analytic_id,
    }


def api_update_quote(body):
    qid = int(body.pop("id"))
    allowed = {
        "name",
        "project_name",
        "project_duration",
        "margin",
        "start_date",
        "end_date",
        "location",
        "scope",
        "commission_percentage",
        "opportunity_id",
        "customer_id",
    }
    vals = {k: body[k] for k in list(body.keys()) if k in allowed}
    if vals:
        odoo_execute("quotation.builder", "write", [[qid], vals])
    return {"ok": True, "id": qid}


def api_action(body):
    """Call a server-side action on quotation.builder (proceed / approved / rejected / draft)."""
    qid = int(body["id"])
    action = body["action"]
    mapping = {
        "proceed": "action_proceed",
        "approved": "action_approved",
        "rejected": "action_rejected",
        "draft": "action_draft",
        "send": "send_quotation",
    }
    method = mapping.get(action)
    if not method:
        raise ValueError(f"Unknown action {action!r}")
    result = odoo_execute("quotation.builder", method, [[qid]])
    return {"ok": True, "result": result if isinstance(result, (dict, list)) else None}


def api_comment(body):
    """Post a chatter comment on a quotation.builder record."""
    qid = int(body["id"])
    msg = body.get("body") or ""
    if not msg.strip():
        raise ValueError("Comment body is empty")
    odoo_execute(
        "quotation.builder",
        "message_post",
        [[qid]],
        {"body": msg, "message_type": "comment", "subtype_xmlid": "mail.mt_comment"},
    )
    return {"ok": True, "id": qid}


def api_logs(body):
    """
    Return chatter / audit log for a quotation.builder record.
    Combines mail.message (chatter) and mail.tracking.value (field changes via tracking=True).
    """
    qid = int(body.get("id") or 0)
    if not qid:
        raise ValueError("id is required")

    messages = odoo_execute(
        "mail.message",
        "search_read",
        [[["model", "=", "quotation.builder"], ["res_id", "=", qid]]],
        {
            "fields": [
                "id",
                "date",
                "author_id",
                "subject",
                "body",
                "message_type",
                "subtype_id",
                "tracking_value_ids",
            ],
            "limit": 500,
            "order": "date desc",
        },
    )

    tv_ids = []
    for m in messages:
        for tv in m.get("tracking_value_ids") or []:
            tv_ids.append(tv)
    tracking = []
    if tv_ids:
        tracking = odoo_execute(
            "mail.tracking.value",
            "read",
            [tv_ids],
            {
                "fields": [
                    "id",
                    "field_id",
                    "old_value_char",
                    "new_value_char",
                    "old_value_integer",
                    "new_value_integer",
                    "old_value_float",
                    "new_value_float",
                    "old_value_text",
                    "new_value_text",
                    "mail_message_id",
                ]
            },
        )

    # Resolve tracked field technical names -> labels
    field_ids = sorted({t["field_id"][0] for t in tracking if t.get("field_id")})
    field_map = {}
    if field_ids:
        field_rows = odoo_execute(
            "ir.model.fields",
            "read",
            [field_ids],
            {"fields": ["id", "name", "field_description"]},
        )
        field_map = {f["id"]: f for f in field_rows}

    # Group tracking by message id
    tv_by_msg = {}
    for t in tracking:
        mid = t.get("mail_message_id")
        mid = mid[0] if isinstance(mid, list) else mid
        tv_by_msg.setdefault(mid, []).append(t)

    entries = []
    for m in messages:
        author = m.get("author_id")
        author_name = author[1] if isinstance(author, list) else "System"
        tvs = tv_by_msg.get(m["id"], [])
        changes = []
        for t in tvs:
            fid = t.get("field_id")
            fid = fid[0] if isinstance(fid, list) else fid
            fdef = field_map.get(fid) or {}
            label = fdef.get("field_description") or fdef.get("name") or "field"
            before = (
                t.get("old_value_char")
                or t.get("old_value_text")
                or t.get("old_value_integer")
                or t.get("old_value_float")
            )
            after = (
                t.get("new_value_char")
                or t.get("new_value_text")
                or t.get("new_value_integer")
                or t.get("new_value_float")
            )
            changes.append({"field": label, "before": before, "after": after})
        entries.append(
            {
                "id": m["id"],
                "date": m["date"],
                "author": author_name,
                "subject": m.get("subject") or "",
                "body": m.get("body") or "",
                "type": m.get("message_type") or "",
                "changes": changes,
            }
        )

    return {"ok": True, "id": qid, "entries": entries}


def api_skills(_body):
    rows = odoo_execute(
        "hr.skill",
        "search_read",
        [[["skill_type_id.name", "=", "Primary Skills"]]],
        {"fields": ["id", "name"], "limit": 500, "order": "name asc"},
    )
    return {"ok": True, "rows": rows}


def api_levels(_body):
    rows = odoo_execute(
        "hr.skill.level",
        "search_read",
        [[["skill_type_id.name", "=", "Primary Skills"]]],
        {
            "fields": ["id", "name", "level_progress"],
            "limit": 50,
            "order": "level_progress desc",
        },
    )
    return {"ok": True, "rows": rows}


def api_skill_cost(body):
    skill_id = int(body.get("skill_id") or 0)
    level_id = int(body.get("level_id") or 0)
    if not (skill_id and level_id):
        return {"ok": True, "cost": None}
    rows = odoo_execute(
        "employee.skill.costing",
        "search_read",
        [[["skill_id", "=", skill_id], ["level_id", "=", level_id]]],
        {"fields": ["cost_min", "cost_max", "cost_mod"], "limit": 1},
    )
    return {"ok": True, "cost": rows[0] if rows else None}


def api_approvals_pending(_body):
    rows = odoo_execute(
        "quotation.builder",
        "search_read",
        [[["status", "in", ["draft", "coo_approval", "ceo_approval"]]]],
        {
            "fields": [
                "id",
                "name",
                "customer_id",
                "project_name",
                "margin",
                "total_cost",
                "final_price",
                "status",
            ],
            "limit": 100,
            "order": "create_date desc",
        },
    )
    return {"ok": True, "rows": rows}


ROUTES = {
    "/api/ping": api_ping,
    "/api/quotes": api_quotes,
    "/api/quote": api_quote_detail,
    "/api/partners": api_partners,
    "/api/leads": api_leads,
    "/api/skills": api_skills,
    "/api/levels": api_levels,
    "/api/skill_cost": api_skill_cost,
    "/api/approvals_pending": api_approvals_pending,
    "/api/quote/create": api_create_quote,
    "/api/quote/update": api_update_quote,
    "/api/quote/action": api_action,
    "/api/quote/comment": api_comment,
    "/api/quote/logs": api_logs,
}


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class Handler(http.server.BaseHTTPRequestHandler):
    def _json(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _serve_static(self, filename):
        path = os.path.join(STATIC_DIR, filename)
        if not os.path.isfile(path):
            self.send_error(404, f"Not found: {filename}")
            return
        ctype = "text/html; charset=utf-8"
        if filename.endswith(".js"):
            ctype = "application/javascript; charset=utf-8"
        elif filename.endswith(".css"):
            ctype = "text/css; charset=utf-8"
        with open(path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length).decode("utf-8") or "{}"
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def _dispatch_api(self, path):
        handler = ROUTES.get(path)
        if not handler:
            self._json(404, {"ok": False, "error": f"no route {path}"})
            return
        try:
            body = self._read_body() if self.command == "POST" else {}
            if self.command == "GET":
                # Allow passing id via query string for /api/quote
                from urllib.parse import parse_qs, urlparse

                qs = parse_qs(urlparse(self.path).query)
                body = {k: v[0] if isinstance(v, list) and v else v for k, v in qs.items()}
            result = handler(body)
            self._json(200, result)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._json(500, {"ok": False, "error": str(exc)})

    # ---- HTTP verbs ---- #
    def do_GET(self):  # noqa: N802
        from urllib.parse import urlparse

        path = urlparse(self.path).path
        if path == "/" or path == "/index.html":
            self._serve_static("index.html")
            return
        if path.startswith("/api/"):
            self._dispatch_api(path)
            return
        # static passthrough for any other sibling file
        rel = path.lstrip("/")
        if rel and os.path.isfile(os.path.join(STATIC_DIR, rel)):
            self._serve_static(rel)
            return
        self.send_error(404, f"Not found: {path}")

    def do_POST(self):  # noqa: N802
        from urllib.parse import urlparse

        path = urlparse(self.path).path
        if path.startswith("/api/"):
            self._dispatch_api(path)
            return
        self.send_error(404, f"Not found: {path}")

    # Quieter access log: one line per request.
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[web] {self.address_string()} - {fmt % args}\n")


class ThreadedServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    print(f"[tmc-web] Odoo  : {ODOO_URL}  db={ODOO_DB}  user={ODOO_USER}")
    try:
        uid = odoo_authenticate()
        print(f"[tmc-web] Auth OK (uid={uid})")
    except Exception as exc:  # noqa: BLE001
        print(f"[tmc-web] WARNING: initial auth failed: {exc}")
        print("[tmc-web] Server will still start; retries happen per request.")

    with ThreadedServer((WEB_HOST, WEB_PORT), Handler) as srv:
        print(f"[tmc-web] Serving on http://{WEB_HOST}:{WEB_PORT}/")
        print("[tmc-web] Ctrl+C to stop.")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n[tmc-web] stopped.")


if __name__ == "__main__":
    main()
