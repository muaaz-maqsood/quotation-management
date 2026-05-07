/* =======================================================================
   TMC Quote Web App — Odoo integration layer.
   Keeps the original UI & every menu untouched. Fetches from and writes to
   the local Odoo instance (db odoo_demo_latest_31_3_25) via /api/*.
   ======================================================================= */
(function () {
  "use strict";

  // ---------- tiny helpers -----------------------------------------------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function fmtNum(n) { return Number(n || 0).toLocaleString("en-US"); }
  function fmtInt(n) { return Math.round(Number(n || 0)).toLocaleString("en-US"); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function setBadge(text, color) {
    var t = document.getElementById("odoo-status-text");
    if (!t) return;
    t.textContent = text;
    t.style.color = color || "#fbbf24";
  }
  function uid() { return "r" + Math.random().toString(36).slice(2, 9); }

  async function apiGet(path) {
    var r = await fetch(path, { method: "GET" });
    var j = await r.json().catch(function () { return { ok: false, error: "bad json" }; });
    if (!j || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
    return j;
  }
  async function apiPost(path, body) {
    var r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    var j = await r.json().catch(function () { return { ok: false, error: "bad json" }; });
    if (!j || !j.ok) throw new Error((j && j.error) || ("HTTP " + r.status));
    return j;
  }

  // ---------- shared state ----------------------------------------------
  var TMC = window.__tmc = {
    skills: [],    // [{id,name}]
    levels: [],    // [{id,name,level_progress}]
    partners: [],  // customers
    leads: [],
    resources: [], // [{uid, skill_id, skill_name, level_id, level_name, wave, alloc_pct, duration, count, monthly_cost, source, location, currency}]
    direct_costs_total: 1390000,  // pulled from #directCostsTable if present
    travel_total: 6528000,        // pulled from travel cards if present
    budget: 45000000,
    currentQuoteId: null,         // from Dashboard "Open"
    scenarios: [],                // [{name, ts, snapshot}]
  };

  var LOCATION_OPTS = ["Onsite – KSA", "Onsite – UAE", "Offshore – PK", "Remote"];
  var WAVE_OPTS = ["W1", "W2", "W3", "W4"];
  var CURRENCY_OPTS = ["PKR", "SAR", "USD", "AED"];

  // ---------- status map (Odoo -> pill class) ---------------------------
  var STATE_MAP = {
    draft: { cls: "state-draft", label: "Draft" },
    coo_approval: { cls: "state-l2", label: "COO Pending" },
    ceo_approval: { cls: "state-l3", label: "CEO Pending" },
    approved: { cls: "state-approved", label: "Approved" },
    rejected: { cls: "state-rejected", label: "Rejected" },
    quote_sent: { cls: "state-pushed", label: "Quotation Sent" },
    accepted: { cls: "state-pushed", label: "Accepted" },
    refused: { cls: "state-rejected", label: "Refused" },
  };
  function stateBadge(status) {
    var s = STATE_MAP[status] || { cls: "state-scratchpad", label: status || "—" };
    return '<span class="state-badge ' + s.cls + '">' + esc(s.label) + "</span>";
  }

  // =====================================================================
  // DASHBOARD
  // =====================================================================
  async function loadDashboard() {
    var dashSection = document.getElementById("view-dashboard");
    if (!dashSection) return;
    var tbody = dashSection.querySelector(".card table.grid tbody");
    if (!tbody) return;

    try {
      var res = await apiGet("/api/quotes");
      var rows = res.rows || [];
      if (!rows.length) {
        tbody.innerHTML =
          '<tr><td colspan="10" style="text-align:center;color:#64748b;padding:20px">No quotations yet. Create one from "+ New Quote".</td></tr>';
      } else {
        tbody.innerHTML = rows
          .map(function (q) {
            var cust = Array.isArray(q.customer_id) ? q.customer_id[1] : "—";
            var dur = q.project_duration ? q.project_duration + " months" : "—";
            return (
              '<tr data-qid="' + q.id + '">' +
              '<td><strong>' + esc(q.name || ("#" + q.id)) + '</strong></td>' +
              '<td>' + esc(cust) + '</td>' +
              '<td>' + esc(q.project_name || "—") + '</td>' +
              '<td>' + esc(dur) + '</td>' +
              '<td class="num">' + fmtInt(q.total_cost) + '</td>' +
              '<td class="num">' + fmtInt(q.final_price) + '</td>' +
              '<td class="num">' + Number(q.margin || 0).toFixed(1) + '%</td>' +
              '<td>' + stateBadge(q.status) + '</td>' +
              '<td>Admin</td>' +
              '<td><button class="btn btn-sm" data-open-quote="' + q.id + '">Open</button></td>' +
              '</tr>'
            );
          })
          .join("");
      }
      // Update KPI cards
      var active = rows.filter(function (r) { return r.status === "draft" || !r.status; }).length;
      var pending = rows.filter(function (r) { return r.status === "coo_approval" || r.status === "ceo_approval"; }).length;
      var won = rows.filter(function (r) { return r.status === "accepted" || r.status === "quote_sent"; });
      var wonTotal = won.reduce(function (s, r) { return s + (r.final_price || 0); }, 0);
      var kpiCards = dashSection.querySelectorAll("div.row .card");
      if (kpiCards.length >= 4) {
        var v0 = kpiCards[0].querySelector("div:nth-child(2)"); if (v0) v0.textContent = active;
        var v1 = kpiCards[1].querySelector("div:nth-child(2)"); if (v1) v1.textContent = pending;
        var v2 = kpiCards[2].querySelector("div:nth-child(2)"); if (v2) v2.textContent = "PKR " + (wonTotal >= 1e6 ? (wonTotal / 1e6).toFixed(1) + "M" : fmtInt(wonTotal));
        var total = rows.length || 1;
        var winRate = Math.round((won.length / total) * 100);
        var v3 = kpiCards[3].querySelector("div:nth-child(2)"); if (v3) v3.textContent = winRate + "%";
      }
    } catch (err) {
      console.error("dashboard load failed:", err);
      tbody.innerHTML =
        '<tr><td colspan="10" style="text-align:center;color:#dc2626;padding:16px">Failed to load quotations from Odoo: ' +
        esc(err.message) +
        "</td></tr>";
    }
  }

  function wireDashboardOpen() {
    var dash = document.getElementById("view-dashboard");
    if (!dash) return;
    dash.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.matches("[data-open-quote]")) {
        var id = parseInt(t.getAttribute("data-open-quote"), 10);
        TMC.currentQuoteId = id;
        window.__tmcCurrentQuoteId = id;
        showQuoteDetailModal(id);
      }
    });
  }

  async function showQuoteDetailModal(id) {
    openModal('<div class="muted">Loading quote ' + id + ' from Odoo…</div>');
    var titleEl = document.getElementById("tmc-modal-title");
    if (titleEl) titleEl.textContent = "Quote Details · id " + id;
    try {
      var res = await apiGet("/api/quote?id=" + id);
      var r = res.record || {};
      var resLines = res.resource_lines || [];
      var costLines = res.cost_lines || [];
      var pay = res.payment_plan || [];
      var cust = Array.isArray(r.customer_id) ? r.customer_id[1] : "—";
      var opp = Array.isArray(r.opportunity_id) ? r.opportunity_id[1] : "—";
      var currency = Array.isArray(r.currency_id) ? r.currency_id[1] : "PKR";

      var head =
        '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:16px">' +
          kv("Quote", r.name) +
          kv("Status", stateBadge(r.status)) +
          kv("Customer", cust) +
          kv("Opportunity", opp) +
          kv("Project Name", r.project_name) +
          kv("Duration", (r.project_duration || 0) + " months") +
          kv("Start → End", (r.start_date || "—") + "  →  " + (r.end_date || "—")) +
          kv("Margin", Number(r.margin || 0).toFixed(1) + "%") +
          kv("Total Cost", currency + " " + fmtInt(r.total_cost)) +
          kv("Final Price", currency + " " + fmtInt(r.final_price)) +
        '</div>';

      var resTable = '<div class="card-title" style="margin:10px 0 6px">Resource Lines</div>';
      if (!resLines.length) {
        resTable += '<div class="muted">None</div>';
      } else {
        resTable +=
          '<table class="grid" style="font-size:12px"><thead><tr>' +
          '<th>Skill</th><th>Level</th><th class="num">Monthly Cost</th><th class="num">CTC %</th><th class="num">Cost + CTC</th><th class="num">Row Total</th>' +
          '</tr></thead><tbody>' +
          resLines.map(function (rl) {
            var s = Array.isArray(rl.skill_id) ? rl.skill_id[1] : "—";
            var lv = Array.isArray(rl.level_id) ? rl.level_id[1] : "—";
            return '<tr>' +
              '<td>' + esc(s) + '</td>' +
              '<td>' + esc(lv) + '</td>' +
              '<td class="num">' + fmtInt(rl.monthly_cost) + '</td>' +
              '<td class="num">' + Number(rl.ctc_factor || 0).toFixed(1) + '</td>' +
              '<td class="num">' + fmtInt(rl.total_per_month_cost_ctc) + '</td>' +
              '<td class="num">' + fmtInt(rl.total_cost) + '</td>' +
            '</tr>';
          }).join("") +
          '</tbody></table>';
      }

      var costTable = '<div class="card-title" style="margin:14px 0 6px">Indirect Costs</div>';
      if (!costLines.length) {
        costTable += '<div class="muted">None</div>';
      } else {
        costTable +=
          '<table class="grid" style="font-size:12px"><thead><tr>' +
          '<th>Cost Type</th><th class="num">Amount</th><th class="num">Total %</th>' +
          '</tr></thead><tbody>' +
          costLines.map(function (c) {
            return '<tr>' +
              '<td>' + esc(c.cost_type || "—") + '</td>' +
              '<td class="num">' + fmtInt(c.amount) + '</td>' +
              '<td class="num">' + Number(c.total_percentage || 0).toFixed(1) + '</td>' +
            '</tr>';
          }).join("") +
          '</tbody></table>';
      }

      var payTable = '<div class="card-title" style="margin:14px 0 6px">Payment Plan</div>';
      if (!pay.length) {
        payTable += '<div class="muted">None</div>';
      } else {
        payTable +=
          '<table class="grid" style="font-size:12px"><thead><tr>' +
          '<th>Phase</th><th>Milestone</th><th class="num">%</th><th class="num">Amount</th>' +
          '</tr></thead><tbody>' +
          pay.map(function (p) {
            return '<tr>' +
              '<td>' + esc(p.phase || "—") + '</td>' +
              '<td>' + esc(p.milestone || "—") + '</td>' +
              '<td class="num">' + Number(p.percentage || 0).toFixed(1) + '</td>' +
              '<td class="num">' + fmtInt(p.percentage_amount) + '</td>' +
            '</tr>';
          }).join("") +
          '</tbody></table>';
      }

      var footer =
        '<div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end">' +
          '<button class="btn" id="tmc-detail-goto-builder">Open in Quote Builder</button>' +
          '<button class="btn btn-primary" id="tmc-detail-goto-approvals">Go to Approvals</button>' +
        '</div>';

      document.getElementById("tmc-modal-body").innerHTML = head + resTable + costTable + payTable + footer;

      var dl = document.getElementById("tmc-modal-download");
      if (dl) dl.style.display = "none";  // not needed here

      var b1 = document.getElementById("tmc-detail-goto-builder");
      if (b1) b1.onclick = function () {
        loadQuoteIntoBuilder(res);
        var m = document.getElementById("tmc-modal"); if (m) m.remove();
        var nav = document.querySelector('[data-view="builder"]'); if (nav) nav.click();
      };
      var b2 = document.getElementById("tmc-detail-goto-approvals");
      if (b2) b2.onclick = function () {
        var m = document.getElementById("tmc-modal"); if (m) m.remove();
        var nav = document.querySelector('[data-view="approvals"]'); if (nav) nav.click();
        renderApprovals();
      };
    } catch (err) {
      document.getElementById("tmc-modal-body").innerHTML =
        '<div style="color:#dc2626">Failed to load quote: ' + esc(err.message) + '</div>';
    }
  }

  function loadQuoteIntoBuilder(res) {
    var r = res.record || {};
    var resLines = res.resource_lines || [];
    var costLines = res.cost_lines || [];

    // --- Section 1 / Section 2 form fields ---
    var sec = findNewQuoteSection();
    if (sec) {
      var cards = sec.querySelectorAll(".card");
      var opp = cards[0];
      if (opp) {
        // Customer dropdown — select if partner id present
        var custSel = opp.querySelector('select[data-role="customer"]');
        if (custSel && Array.isArray(r.customer_id)) {
          custSel.value = String(r.customer_id[0]);
        }
        // Opportunity / lead
        var leadSel = opp.querySelector('select[data-role="lead"]');
        if (leadSel && Array.isArray(r.opportunity_id)) {
          leadSel.value = String(r.opportunity_id[0]);
        }
        // Project name
        var projInput = opp.querySelector('input[type="text"]:not(#tmc-new-customer-name)');
        if (projInput) projInput.value = r.project_name || "";
        // Duration
        var durInput = opp.querySelector('input[type="number"]');
        if (durInput) durInput.value = r.project_duration || "";
        // Start month from start_date
        var startInput = opp.querySelector('input[type="month"]');
        if (startInput && r.start_date) startInput.value = String(r.start_date).slice(0, 7);
      }
      // Budget card (Section 2) — Target Margin
      var bCard = cards[1];
      if (bCard) {
        var bInputs = bCard.querySelectorAll('input[type="number"]');
        // bInputs[1] = Target Margin % (convention per existing form)
        if (bInputs[1]) bInputs[1].value = (r.margin != null) ? r.margin : "";
      }
    }

    // --- Section 3: rebuild TMC.resources from Odoo resource lines ---
    TMC.resources = (resLines || []).map(function (rl) {
      var skillName = Array.isArray(rl.skill_id) ? rl.skill_id[1] : "";
      var levelName = Array.isArray(rl.level_id) ? rl.level_id[1] : "";
      return {
        uid: uid(),
        skill_id: Array.isArray(rl.skill_id) ? rl.skill_id[0] : null,
        skill_name: skillName,
        level_id: Array.isArray(rl.level_id) ? rl.level_id[0] : null,
        level_name: levelName,
        wave: "W1",
        alloc_pct: 100,
        duration: r.project_duration || 6,
        count: 1,
        monthly_cost: rl.monthly_cost || 0,
        override_cost: null,
        source: "Odoo",
        location: "Onsite – KSA",
        currency: "PKR",
      };
    });

    // --- Direct cost lines (Section 5) ---
    var dcTable = document.getElementById("directCostsTable");
    if (dcTable) {
      var dcBody = dcTable.querySelector("tbody");
      if (dcBody) {
        if (costLines.length) {
          dcBody.innerHTML = costLines.map(function (c) {
            return '<tr>' +
              '<td contenteditable="true">' + esc(c.cost_type || "—") + '</td>' +
              '<td contenteditable="true">' + esc(c.cost_type || "Other") + '</td>' +
              '<td class="num dc-qty" contenteditable="true">1</td>' +
              '<td class="num dc-unit" contenteditable="true" style="background:#f0fdf4">' + fmtInt(c.amount) + '</td>' +
              '<td class="num dc-total" style="background:#f8fafc;font-weight:600">' + fmtInt(c.amount) + '</td>' +
              '<td><button class="btn btn-sm" onclick="this.closest(\'tr\').remove();recalcDirect()">&times;</button></td>' +
            '</tr>';
          }).join("");
          var grand = costLines.reduce(function (s, c) { return s + (c.amount || 0); }, 0);
          var dcG = document.getElementById("dcGrand"); if (dcG) dcG.textContent = fmtInt(grand);
          TMC.direct_costs_total = grand;
        } else {
          dcBody.innerHTML = "";
          var dcG2 = document.getElementById("dcGrand"); if (dcG2) dcG2.textContent = "0";
          TMC.direct_costs_total = 0;
        }
      }
    }

    // --- Quote-level state ---
    TMC.currentQuoteId = r.id || null;
    TMC.budget = 0;  // if user needs it, they can set it on the form

    // --- Re-render everything ---
    renderResourceTable();
    renderBuilderGrid();
    updateBuilderKpis();
    // Reset scenarios baseline to this loaded quote
    TMC.scenarios = [];
    seedBaselineScenario();
    renderScenarios();
  }

  function kv(label, val) {
    return '<div style="background:#f8fafc;padding:8px 10px;border-radius:4px;border:1px solid var(--border)">' +
      '<div class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px">' + esc(label) + '</div>' +
      '<div style="margin-top:3px;font-weight:600">' + (val == null || val === "" ? "—" : val) + '</div>' +
    '</div>';
  }

  // =====================================================================
  // NEW QUOTE · SECTION 1 (dropdowns) & SECTION 3 (Skill & Resource Plan)
  // =====================================================================
  function findNewQuoteSection() { return document.getElementById("view-newquote"); }

  async function populateTopDropdowns() {
    var section = findNewQuoteSection();
    if (!section) return;
    var cards = section.querySelectorAll(".card");
    var oppCard = cards[0];
    if (!oppCard) return;
    var selects = oppCard.querySelectorAll("select");
    if (!selects.length) return;
    try {
      TMC.partners = (await apiGet("/api/partners")).rows || [];
      try { TMC.leads = (await apiGet("/api/leads")).rows || []; } catch (e) { TMC.leads = []; }

      // First select = Customer; prepend a "new" option that swaps to a text input.
      if (selects[0]) {
        selects[0].innerHTML =
          '<option value="">— Select customer —</option>' +
          '<option value="__new__">➕ Add new (type name below — will create on Push)</option>' +
          TMC.partners.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join("");
        selects[0].setAttribute("data-role", "customer");
        ensureNewCustomerInput(selects[0]);
        selects[0].onchange = function () {
          var box = document.getElementById("tmc-new-customer-wrap");
          if (box) box.style.display = selects[0].value === "__new__" ? "block" : "none";
        };
      }
      // Second select = Opportunity / CRM lead
      if (selects[1]) {
        selects[1].innerHTML =
          '<option value="">— none —</option>' +
          TMC.leads.map(function (l) { return '<option value="' + l.id + '">' + esc(l.name) + '</option>'; }).join("");
        selects[1].setAttribute("data-role", "lead");
      }
    } catch (err) {
      console.warn("dropdown populate failed:", err);
    }
  }

  function ensureNewCustomerInput(selectEl) {
    if (document.getElementById("tmc-new-customer-wrap")) return;
    var wrap = document.createElement("div");
    wrap.id = "tmc-new-customer-wrap";
    wrap.style.cssText = "display:none;margin-top:6px";
    wrap.innerHTML =
      '<input id="tmc-new-customer-name" type="text" placeholder="New customer name (will be created in Odoo res.partner on Push)" style="width:100%;padding:7px;border:1px dashed #d97706;border-radius:4px;background:#fffbeb">' +
      '<small class="muted" style="display:block;margin-top:3px">A new company-type partner will be created in Odoo when you Save / Push this quote.</small>';
    // Insert right below the customer select inside its <label> container
    var label = selectEl.closest("label") || selectEl.parentElement;
    label.appendChild(wrap);
  }

  async function loadSkillsAndLevels() {
    try {
      TMC.skills = (await apiGet("/api/skills")).rows || [];
      TMC.levels = (await apiGet("/api/levels")).rows || [];
    } catch (err) {
      console.warn("skills/levels load failed", err);
    }
  }

  // Start empty — no hardcoded seed resources. User adds via "+ Add Row".
  function seedResources() { /* intentionally empty */ }

  // Effective monthly cost = override if user typed one, else the Odoo default
  function effectiveMonthlyCost(r) {
    var ov = parseFloat(r.override_cost);
    return (!isNaN(ov) && ov > 0) ? ov : (r.monthly_cost || 0);
  }

  // -- render Section 3 table body from TMC.resources
  function renderResourceTable() {
    var section = findNewQuoteSection();
    if (!section) return;
    var card = section.querySelectorAll(".card")[2]; // 3rd card = Skill & Resource Plan
    if (!card) return;
    var tbody = card.querySelector("table.grid tbody");
    if (!tbody) return;

    // Hide the static "Wave" column header (once)
    var thead = card.querySelector("table.grid thead tr");
    if (thead) {
      thead.querySelectorAll("th").forEach(function (th) {
        if (/^wave$/i.test(th.textContent.trim())) th.style.display = "none";
      });
      // Inject "Override Cost" header once, right after "HR Cost / Month (PKR)"
      if (!thead.querySelector("th[data-col=override-cost]")) {
        var hrTh = null;
        thead.querySelectorAll("th").forEach(function (th) {
          if (/hr cost \/ month/i.test(th.textContent)) hrTh = th;
        });
        if (hrTh) {
          var ovTh = document.createElement("th");
          ovTh.className = "num";
          ovTh.setAttribute("data-col", "override-cost");
          ovTh.style.background = "#fef3c7";
          ovTh.innerHTML = 'OVERRIDE COST<br><small class="muted" style="font-weight:400">blank = use default</small>';
          hrTh.parentNode.insertBefore(ovTh, hrTh.nextSibling);
        }
      }
    }

    tbody.innerHTML = TMC.resources.map(function (r) {
      var skillOpts = '<option value="">— pick skill —</option>' + TMC.skills.map(function (s) {
        var sel = (s.id === r.skill_id) ? " selected" : "";
        return '<option value="' + s.id + '"' + sel + '>' + esc(s.name) + '</option>';
      }).join("");
      // If current skill isn't in the Odoo list (free-typed seed), add a custom option
      if (r.skill_name && !TMC.skills.find(function (s) { return s.id === r.skill_id; })) {
        skillOpts = '<option value="" selected>' + esc(r.skill_name) + ' (custom)</option>' + skillOpts;
      }
      var lvlOpts = '<option value="">— pick level —</option>' + TMC.levels.map(function (l) {
        var sel = (l.id === r.level_id) ? " selected" : "";
        return '<option value="' + l.id + '"' + sel + '>' + esc(l.name) + '</option>';
      }).join("");
      var locOpts = LOCATION_OPTS.map(function (L) {
        return '<option value="' + esc(L) + '"' + (L === r.location ? " selected" : "") + '>' + esc(L) + '</option>';
      }).join("");
      var curOpts = CURRENCY_OPTS.map(function (c) {
        return '<option value="' + c + '"' + (c === r.currency ? " selected" : "") + '>' + c + '</option>';
      }).join("");
      var hasOverride = r.override_cost != null && r.override_cost !== "" && !isNaN(parseFloat(r.override_cost));
      var pill = hasOverride
        ? '<span class="pill pill-warn">Override</span>'
        : (r.source === "Odoo"
            ? '<span class="pill pill-ok">Odoo</span>'
            : '<span class="pill pill-info">' + esc(r.source || "Manual") + '</span>');
      return (
        '<tr data-uid="' + r.uid + '">' +
        '<td><select data-k="skill_id" style="width:160px">' + skillOpts + '</select></td>' +
        '<td><select data-k="level_id" style="width:120px">' + lvlOpts + '</select></td>' +
        '<td class="num"><input data-k="alloc_pct" type="number" value="' + r.alloc_pct + '" style="width:70px;text-align:right"></td>' +
        '<td class="num"><input data-k="duration" type="number" value="' + r.duration + '" style="width:70px;text-align:right"></td>' +
        '<td class="num"><input data-k="count" type="number" value="' + r.count + '" style="width:60px;text-align:right"></td>' +
        '<td class="num" style="background:#f0fdf4">' +
          '<input data-k="monthly_cost" type="number" value="' + r.monthly_cost + '" readonly style="width:130px;text-align:right;background:transparent;border:none;font:inherit;cursor:not-allowed" title="Default from Odoo skill.master">' +
        '</td>' +
        '<td class="num" style="background:#fef3c7">' +
          '<input data-k="override_cost" type="number" value="' + (hasOverride ? r.override_cost : "") + '" placeholder="—" style="width:130px;text-align:right;background:transparent;border:none;font:inherit" title="Override the default cost — used for all downstream calculations when set">' +
        '</td>' +
        '<td>' + pill + '</td>' +
        '<td><select data-k="location" style="width:130px">' + locOpts + '</select></td>' +
        '<td><select data-k="currency" style="width:70px">' + curOpts + '</select></td>' +
        '<td><button class="btn btn-sm" data-del-row>&times;</button></td>' +
        '</tr>'
      );
    }).join("");

    wireResourceRowEvents(tbody);
  }

  function wireResourceRowEvents(tbody) {
    // delegate-style: single listener for change / input / click
    tbody.onchange = tbody.oninput = function (e) {
      var el = e.target;
      var tr = el.closest("tr[data-uid]");
      if (!tr) return;
      var r = TMC.resources.find(function (x) { return x.uid === tr.getAttribute("data-uid"); });
      if (!r) return;
      var k = el.getAttribute("data-k");
      if (!k) return;
      var v = el.value;
      if (["alloc_pct", "duration", "count", "monthly_cost"].indexOf(k) >= 0) {
        r[k] = parseFloat(v) || 0;
      } else if (k === "override_cost") {
        // Blank -> clear the override (fall back to Odoo default)
        if (v === "" || v === null) {
          r.override_cost = null;
        } else {
          var pv = parseFloat(v);
          r.override_cost = isNaN(pv) ? null : pv;
        }
        renderBuilderGrid();
        updateBuilderKpis();
        return;
      } else if (k === "skill_id") {
        r.skill_id = v ? parseInt(v, 10) : null;
        var sObj = TMC.skills.find(function (s) { return s.id === r.skill_id; });
        r.skill_name = sObj ? sObj.name : "";
        // refresh cost from Odoo
        refreshMonthlyCostFromOdoo(r).then(function () { renderResourceTable(); renderBuilderGrid(); });
        return;
      } else if (k === "level_id") {
        r.level_id = v ? parseInt(v, 10) : null;
        var lObj = TMC.levels.find(function (l) { return l.id === r.level_id; });
        r.level_name = lObj ? lObj.name : "";
        refreshMonthlyCostFromOdoo(r).then(function () { renderResourceTable(); renderBuilderGrid(); });
        return;
      } else {
        r[k] = v;
      }
      // if user typed a custom monthly cost, mark as override
      if (k === "monthly_cost") r.source = "Override";
      renderBuilderGrid();  // propagate to grid
      updateBuilderKpis();
    };

    tbody.onclick = function (e) {
      var btn = e.target.closest("[data-del-row]");
      if (!btn) return;
      var tr = btn.closest("tr[data-uid]");
      if (!tr) return;
      var id = tr.getAttribute("data-uid");
      TMC.resources = TMC.resources.filter(function (x) { return x.uid !== id; });
      renderResourceTable();
      renderBuilderGrid();
      updateBuilderKpis();
    };
  }

  async function refreshMonthlyCostFromOdoo(r) {
    if (!r.skill_id || !r.level_id) return;
    try {
      var costBasis = (document.querySelector("#view-newquote .card:nth-of-type(2) select:nth-of-type(2)") || {}).value;  // Costing Basis dropdown — but using index for simplicity
      var res = await fetch("/api/skill_cost", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skill_id: r.skill_id, level_id: r.level_id }),
      }).then(function (r) { return r.json(); });
      if (res && res.ok && res.cost) {
        r.monthly_cost = res.cost.cost_max || res.cost.cost_mod || res.cost.cost_min || r.monthly_cost;
        r.source = "Odoo";
      } else {
        r.source = "Manual";
      }
    } catch (err) {
      console.warn("skill_cost failed", err);
    }
  }

  // -- Add Row in Section 3
  function wireAddRowButton() {
    var section = findNewQuoteSection();
    if (!section) return;
    var card = section.querySelectorAll(".card")[2];
    if (!card) return;
    var btn = card.querySelector(".card-title .btn");
    if (!btn) return;
    btn.textContent = "+ Add Row";
    btn.onclick = function () {
      var lvlSenior = TMC.levels.find(function (l) { return /senior/i.test(l.name); }) || TMC.levels[0] || {};
      var newR = {
        uid: uid(),
        skill_id: null, skill_name: "",
        level_id: lvlSenior.id || null, level_name: lvlSenior.name || "",
        wave: "W1", alloc_pct: 100, duration: 6, count: 1,
        monthly_cost: 0, source: "Manual",
        location: LOCATION_OPTS[0], currency: "PKR",
      };
      TMC.resources.push(newR);
      renderResourceTable();
      renderBuilderGrid();
      updateBuilderKpis();
    };
  }

  // =====================================================================
  // QUOTE BUILDER GRID
  // =====================================================================
  function getDurationMonths() {
    var sec = findNewQuoteSection();
    if (!sec) return 6;
    var oppCard = sec.querySelectorAll(".card")[0];
    var dInput = oppCard ? oppCard.querySelectorAll('input[type="number"]')[0] : null;
    var v = dInput ? parseInt(dInput.value, 10) : 6;
    return (v && v > 0 && v < 36) ? v : 6;
  }

  function monthLabels(n) {
    var sec = findNewQuoteSection();
    var oppCard = sec ? sec.querySelectorAll(".card")[0] : null;
    var startEl = oppCard ? oppCard.querySelector('input[type="month"]') : null;
    var mstr = startEl && startEl.value ? startEl.value : "2027-01";
    var parts = mstr.split("-");
    var y = parseInt(parts[0], 10) || 2027;
    var m = parseInt(parts[1], 10) || 1;
    var out = [];
    var monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    for (var i = 0; i < n; i++) {
      var mm = ((m - 1 + i) % 12);
      var yy = y + Math.floor((m - 1 + i) / 12);
      out.push(monthNames[mm] + "'" + String(yy).slice(2));
    }
    return out;
  }

  function renderBuilderGrid() {
    var table = document.getElementById("resourceGrid");
    if (!table) return;
    var n = getDurationMonths();
    var labels = monthLabels(n);

    // Rebuild thead
    var thead = table.querySelector("thead");
    if (thead) {
      thead.innerHTML = '<tr>' +
        '<th>Resource</th><th>Seniority</th><th>Location</th>' +
        labels.map(function (L) { return '<th class="num">' + esc(L) + '</th>'; }).join("") +
        '<th class="num" style="background:#eef2f7">HR Cost / Month (PKR)</th>' +
        '<th class="num">Row Total</th>' +
        '<th></th>' +
        '</tr>';
    }

    // Rebuild tbody: one row per (resource × count), with alloc-per-month + CTC + row total
    var tbody = table.querySelector("tbody");
    if (!tbody) return;
    var rowsHtml = "";
    var hrTotal = 0;
    TMC.resources.forEach(function (r) {
      var eff = effectiveMonthlyCost(r);
      for (var c = 0; c < (r.count || 1); c++) {
        var rowMonths = [];
        for (var i = 0; i < n; i++) {
          var alloc = (i < (r.duration || 0)) ? (r.alloc_pct || 0) : 0;
          rowMonths.push(alloc);
        }
        var sumAlloc = rowMonths.reduce(function (a, b) { return a + b; }, 0);
        var rowTotal = eff * (sumAlloc / 100);
        hrTotal += rowTotal;
        var label = (r.skill_name || "—") + ((r.count || 1) > 1 ? " #" + (c + 1) : "");
        var ctcBg = (r.override_cost != null) ? "#fef3c7" : "#f0fdf4";
        rowsHtml +=
          '<tr data-uid="' + r.uid + '" data-seat="' + c + '">' +
          '<td>' + esc(label) + '</td>' +
          '<td>' + esc(r.level_name || "—") + '</td>' +
          '<td>' + esc((r.location || "").indexOf("Onsite") >= 0 ? "Onsite" : "Offshore") + '</td>' +
          rowMonths.map(function (a) { return '<td class="num grid-alloc" contenteditable="true">' + a + '</td>'; }).join("") +
          '<td class="num grid-ctc" contenteditable="true" style="background:' + ctcBg + '" title="' + (r.override_cost != null ? "Override in use" : "Odoo default") + '">' + fmtInt(eff) + '</td>' +
          '<td class="num grid-total" style="background:#f8fafc;font-weight:600">' + fmtInt(rowTotal) + '</td>' +
          '<td><button class="btn btn-sm" data-grid-del>&times;</button></td>' +
          '</tr>';
      }
    });

    // Summary rows (HR subtotal, Direct costs, Travel, Grand total)
    TMC.direct_costs_total = pullDirectCostsTotal();
    TMC.travel_total = pullTravelTotal();
    var grandCost = hrTotal + TMC.direct_costs_total + TMC.travel_total;
    var colspanMonths = 3 + n; // resource + seniority + location + months
    rowsHtml +=
      '<tr style="background:#fef3c7"><td colspan="' + (colspanMonths + 1) + '" style="text-align:right;font-weight:600">HR Subtotal</td><td class="num">&mdash;</td><td class="num" style="font-weight:700">PKR ' + fmtInt(hrTotal) + '</td><td></td></tr>' +
      '<tr style="background:#eff6ff"><td colspan="' + (colspanMonths + 1) + '" style="text-align:right;font-weight:600">Direct Costs (Licenses + Other)</td><td class="num">&mdash;</td><td class="num" style="font-weight:700">PKR ' + fmtInt(TMC.direct_costs_total) + '</td><td></td></tr>' +
      '<tr style="background:#ecfdf5"><td colspan="' + (colspanMonths + 1) + '" style="text-align:right;font-weight:600">Travel</td><td class="num">&mdash;</td><td class="num" style="font-weight:700">PKR ' + fmtInt(TMC.travel_total) + '</td><td></td></tr>' +
      '<tr style="background:var(--brand);color:#fff"><td colspan="' + (colspanMonths + 1) + '" style="text-align:right;font-weight:700">GRAND TOTAL COST</td><td class="num">&mdash;</td><td class="num" style="font-weight:700">PKR ' + fmtInt(grandCost) + '</td><td></td></tr>';

    tbody.innerHTML = rowsHtml;
    wireBuilderGridEvents(tbody);

    // Cache totals
    TMC.hr_total = hrTotal;
    TMC.grand_cost = grandCost;
  }

  function wireBuilderGridEvents(tbody) {
    // edit on blur (contenteditable cells)
    tbody.addEventListener("blur", function (e) {
      var td = e.target;
      if (!td || !td.classList) return;
      var tr = td.closest("tr[data-uid]");
      if (!tr) return;
      var id = tr.getAttribute("data-uid");
      var r = TMC.resources.find(function (x) { return x.uid === id; });
      if (!r) return;
      if (td.classList.contains("grid-ctc")) {
        var v = parseFloat(td.textContent.replace(/[^0-9.-]/g, ""));
        if (isNaN(v) || v <= 0) {
          r.override_cost = null;   // revert to Odoo default
        } else {
          r.override_cost = v;
        }
        renderResourceTable();
        renderBuilderGrid();
        updateBuilderKpis();
      } else if (td.classList.contains("grid-alloc")) {
        // update alloc_pct based on max alloc across months (and compute duration as # of nonzero months)
        var allocs = Array.from(tr.querySelectorAll("td.grid-alloc")).map(function (x) {
          return parseFloat(x.textContent.replace(/[^0-9.-]/g, "")) || 0;
        });
        var nonZero = allocs.filter(function (a) { return a > 0; });
        r.alloc_pct = nonZero.length ? Math.round(nonZero.reduce(function (a, b) { return a + b; }, 0) / nonZero.length) : 0;
        r.duration = nonZero.length;
        renderResourceTable();
        renderBuilderGrid();
        updateBuilderKpis();
      }
    }, true);

    tbody.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-grid-del]");
      if (!btn) return;
      var tr = btn.closest("tr[data-uid]");
      if (!tr) return;
      var id = tr.getAttribute("data-uid");
      var seat = parseInt(tr.getAttribute("data-seat") || "0", 10);
      var r = TMC.resources.find(function (x) { return x.uid === id; });
      if (!r) return;
      if ((r.count || 1) > 1) {
        r.count = r.count - 1;  // drop one seat
      } else {
        TMC.resources = TMC.resources.filter(function (x) { return x.uid !== id; });
      }
      renderResourceTable();
      renderBuilderGrid();
      updateBuilderKpis();
    });
  }

  function pullDirectCostsTotal() {
    var el = document.getElementById("dcGrand");
    if (!el) return TMC.direct_costs_total || 0;
    return parseFloat(el.textContent.replace(/[^0-9.-]/g, "")) || 0;
  }
  function pullTravelTotal() {
    var el = document.getElementById("grandTravelTotal");
    if (!el) return TMC.travel_total || 0;
    return parseFloat(el.textContent.replace(/[^0-9.-]/g, "")) || 0;
  }

  function pullBudgetFromForm() {
    var sec = findNewQuoteSection();
    if (!sec) return TMC.budget;
    // Section 2 (Budget & Commercial Basis) → bInputs[0] is Budget Amount
    var bCard = sec.querySelectorAll(".card")[1];
    if (!bCard) return TMC.budget;
    var bInputs = bCard.querySelectorAll('input[type="number"]');
    if (!bInputs.length) return TMC.budget;
    var v = parseFloat((bInputs[0].value || "").replace(/[^0-9.-]/g, ""));
    return (v && v > 0) ? v : TMC.budget;
  }

  function updateBuilderKpis() {
    var view = document.getElementById("view-builder");
    if (!view) return;
    TMC.budget = pullBudgetFromForm();
    var hr = TMC.hr_total || 0;
    var direct = TMC.direct_costs_total || 0;
    var travel = TMC.travel_total || 0;
    var cost = hr + direct + travel;
    var marginSlider = document.getElementById("marginSlider");
    var margin = marginSlider ? parseFloat(marginSlider.value) : 15;
    var price = cost / (1 - margin / 100);
    var commission = price * 0.05;  // 5% default

    var cards = view.querySelectorAll(".row .card");
    if (cards.length >= 6) {
      // card 0: Budget
      var v0 = cards[0].querySelector('div:nth-child(2)'); if (v0) v0.textContent = "PKR " + fmtInt(TMC.budget);
      // card 2: Total Cost
      var v2 = cards[2].querySelector('div:nth-child(2)'); if (v2) v2.textContent = "PKR " + fmtInt(cost);
      // card 3: margin (leave slider; update the label div)
      var vm = cards[3].querySelector('div:last-child'); if (vm) vm.textContent = margin.toFixed(1) + "%";
      // card 4: Quoted price
      var v4 = cards[4].querySelector('div:nth-child(2)'); if (v4) v4.textContent = "PKR " + fmtInt(price);
      // card 5: Commission
      var v5 = cards[5].querySelector('div:nth-child(2)'); if (v5) v5.textContent = "PKR " + fmtInt(commission);
    }

    // Update gauge text (budget % used) inside the builder gauge card
    var gauge = cards[1] && cards[1].querySelector("svg text");
    if (gauge) {
      var pct = TMC.budget > 0 ? (cost / TMC.budget) * 100 : 0;
      gauge.textContent = pct.toFixed(1) + "%";
      gauge.setAttribute("fill", pct > 100 ? "#dc2626" : (pct > 95 ? "#d97706" : "var(--brand)"));
    }

    // Re-render scenarios (so the "Current" column stays live)
    renderScenarios();
  }

  function wireMarginSlider() {
    var s = document.getElementById("marginSlider");
    if (!s) return;
    s.addEventListener("input", updateBuilderKpis);
  }

  // =====================================================================
  // SCENARIOS VIEW (before/after change tracking)
  // =====================================================================
  function snapshotCurrentState(label) {
    var hr = TMC.hr_total || 0;
    var direct = TMC.direct_costs_total || 0;
    var travel = TMC.travel_total || 0;
    var totalCost = hr + direct + travel;
    var marginSlider = document.getElementById("marginSlider");
    var margin = marginSlider ? parseFloat(marginSlider.value) : 15;
    var price = totalCost ? totalCost / (1 - margin / 100) : 0;
    var budget = TMC.budget || pullBudgetFromForm();
    return {
      label: label || "Snapshot",
      ts: new Date().toLocaleString(),
      duration: getDurationMonths(),
      resources_count: TMC.resources.reduce(function (s, r) { return s + (r.count || 1); }, 0),
      resources: TMC.resources.map(function (r) {
        return {
          uid: r.uid,
          skill: r.skill_name || "—",
          level: r.level_name || "—",
          wave: r.wave,
          alloc: r.alloc_pct,
          duration: r.duration,
          count: r.count,
          monthly_cost: r.monthly_cost,
          location: r.location,
        };
      }),
      hr_cost: hr,
      direct_cost: direct,
      travel_cost: travel,
      total_cost: totalCost,
      margin: margin,
      quoted_price: price,
      budget: budget,
      budget_used_pct: budget > 0 ? (totalCost / budget) * 100 : 0,
    };
  }

  function seedBaselineScenario() {
    if (TMC.scenarios.length) return;
    TMC.scenarios.push({ name: "Baseline", snapshot: snapshotCurrentState("Baseline") });
  }

  function saveScenario() {
    var n = TMC.scenarios.length;  // baseline already there, so first save is 'A'
    var label = "Scenario " + String.fromCharCode(64 + n);  // A, B, C...
    TMC.scenarios.push({ name: label, snapshot: snapshotCurrentState(label) });
    renderScenarios();
    alert("Saved " + label + " — open Scenarios tab to compare.");
  }

  function fmtM(n) {
    var v = Number(n || 0);
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return fmtInt(v);
  }

  function deltaCell(current, baseline, better) {
    // better = 'lower' (green if current < baseline) | 'higher' | null
    var diff = current - baseline;
    if (Math.abs(diff) < 0.001) return { text: fmtM(current), color: null };
    var pct = baseline === 0 ? 0 : (diff / baseline) * 100;
    var sign = diff > 0 ? "+" : "";
    var label = sign + fmtM(diff) + " (" + sign + pct.toFixed(1) + "%)";
    var color = null;
    if (better === "lower") color = diff < 0 ? "#d1fae5" : "#fee2e2";
    else if (better === "higher") color = diff > 0 ? "#d1fae5" : "#fee2e2";
    return { text: fmtM(current) + ' <small class="muted" style="display:block">' + label + "</small>", color: color };
  }

  function renderScenarios() {
    var sec = document.getElementById("view-scenarios");
    if (!sec) return;
    if (!TMC.scenarios.length) return;

    // All columns: each saved scenario + live current
    var currentSnap = snapshotCurrentState("Current · Live");
    var cols = TMC.scenarios.map(function (s) { return { label: s.name, snap: s.snapshot }; });
    cols.push({ label: "Current · Live", snap: currentSnap });
    var baseline = TMC.scenarios[0].snapshot;

    // Key metrics rows (baseline reference = first scenario)
    var metricRows = [
      { key: "duration", label: "Duration (months)", better: null, fmt: function (v) { return v + " months"; } },
      { key: "resources_count", label: "Resources", better: null, fmt: function (v) { return v; } },
      { key: "hr_cost", label: "HR Cost", better: "lower", fmt: fmtM },
      { key: "travel_cost", label: "Travel Cost", better: "lower", fmt: fmtM },
      { key: "direct_cost", label: "Direct Cost", better: "lower", fmt: fmtM },
      { key: "total_cost", label: "Total Cost", better: "lower", fmt: fmtM },
      { key: "budget_used_pct", label: "Budget % Used", better: "lower", fmt: function (v) { return v.toFixed(1) + "%"; } },
      { key: "margin", label: "Margin %", better: null, fmt: function (v) { return v.toFixed(1) + "%"; } },
      { key: "quoted_price", label: "Quoted Price", better: null, fmt: fmtM },
    ];

    // Header row HTML
    var header = '<tr><th style="background:#f8fafc">Field</th>' + cols.map(function (c, i) {
      var badge = i === 0 ? '<span class="pill pill-info" style="margin-left:4px">Baseline</span>'
                 : i === cols.length - 1 ? '<span class="pill pill-ok" style="margin-left:4px">Live</span>'
                 : "";
      var sub = c.snap.ts ? '<div class="muted" style="font-size:10px;font-weight:400">' + esc(c.snap.ts) + '</div>' : "";
      return '<th style="background:#f8fafc;text-align:center">' + esc(c.label) + badge + sub + '</th>';
    }).join("") + "</tr>";

    var body = metricRows.map(function (m) {
      var cells = cols.map(function (c, i) {
        var v = c.snap[m.key];
        if (i === 0) return '<td style="text-align:center">' + m.fmt(v) + '</td>';
        if (m.better) {
          var d = deltaCell(v, baseline[m.key], m.better);
          return '<td style="text-align:center' + (d.color ? ';background:' + d.color : "") + '">' + d.text + '</td>';
        }
        return '<td style="text-align:center">' + m.fmt(v) + '</td>';
      }).join("");
      return '<tr><td style="font-weight:600">' + m.label + '</td>' + cells + '</tr>';
    }).join("");

    // Diff section: which resources changed since baseline
    var diffRows = diffResourcesVsBaseline(baseline.resources, currentSnap.resources);

    // Clear old grid (the static 220px / repeat(3, 1fr) div) — replace view contents while keeping header
    var header_el = sec.querySelector(".view-header");
    // Remove everything after the view-header
    while (header_el && header_el.nextSibling) sec.removeChild(header_el.nextSibling);

    var summary = document.createElement("div");
    summary.className = "card";
    summary.style.padding = "0";
    summary.style.overflow = "auto";
    summary.innerHTML =
      '<div style="padding:10px 16px;background:#f8fafc;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted)">' +
      'Side-by-side <strong>change tracking</strong> — leftmost column is the baseline (auto-captured on first load), rightmost is the live state. Saved snapshots sit in between. Green = improvement vs baseline, red = worse, cells show delta.' +
      '</div>' +
      '<table class="grid" style="font-size:12px;width:100%"><thead>' + header + '</thead><tbody>' + body + '</tbody></table>';
    sec.appendChild(summary);

    var diff = document.createElement("div");
    diff.className = "card";
    diff.innerHTML =
      '<div class="card-title">Resource Changes · Baseline vs Current</div>' +
      (diffRows.length === 0
        ? '<div class="muted" style="font-size:12px">No resource-level changes yet.</div>'
        : '<table class="grid" style="font-size:12px"><thead><tr><th>Change</th><th>Skill</th><th>Seniority</th><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>' +
          diffRows.map(function (d) {
            var pill = d.kind === "added" ? '<span class="pill pill-ok">Added</span>'
                    : d.kind === "removed" ? '<span class="pill pill-err">Removed</span>'
                    : '<span class="pill pill-warn">Modified</span>';
            return '<tr><td>' + pill + '</td><td>' + esc(d.skill) + '</td><td>' + esc(d.level) + '</td><td>' + esc(d.field || "—") + '</td><td>' + esc(String(d.before == null ? "—" : d.before)) + '</td><td>' + esc(String(d.after == null ? "—" : d.after)) + '</td></tr>';
          }).join("") + "</tbody></table>");
    sec.appendChild(diff);

    // Wire header buttons
    var cloneBtn = sec.querySelector(".view-header .actions button");
    if (cloneBtn) {
      cloneBtn.textContent = "+ Save Current as Scenario";
      cloneBtn.onclick = saveScenario;
    }
  }

  function diffResourcesVsBaseline(baseResources, currResources) {
    var out = [];
    var bMap = {}, cMap = {};
    baseResources.forEach(function (r) { bMap[r.uid] = r; });
    currResources.forEach(function (r) { cMap[r.uid] = r; });
    // Added
    currResources.forEach(function (r) {
      if (!bMap[r.uid]) {
        out.push({ kind: "added", skill: r.skill, level: r.level, field: "new row", before: "—", after: r.count + " × " + fmtInt(r.monthly_cost) });
      }
    });
    // Removed
    baseResources.forEach(function (r) {
      if (!cMap[r.uid]) {
        out.push({ kind: "removed", skill: r.skill, level: r.level, field: "row deleted", before: r.count + " × " + fmtInt(r.monthly_cost), after: "—" });
      }
    });
    // Modified
    currResources.forEach(function (r) {
      var b = bMap[r.uid];
      if (!b) return;
      ["alloc", "duration", "count", "monthly_cost", "location", "wave"].forEach(function (f) {
        if (String(b[f]) !== String(r[f])) {
          out.push({ kind: "modified", skill: r.skill, level: r.level, field: f, before: b[f], after: r[f] });
        }
      });
    });
    return out;
  }

  function wireSaveScenarioButton() {
    var btn = document.querySelector('#view-builder .view-header .actions button:nth-of-type(2)');
    if (!btn) return;
    if (/save scenario/i.test(btn.textContent)) btn.onclick = saveScenario;
  }

  // =====================================================================
  // APPROVALS VIEW
  // =====================================================================
  async function renderApprovals() {
    var sec = document.getElementById("view-approvals");
    if (!sec) return;

    // Add a quote picker + action buttons at the top if not already there.
    var host = sec.querySelector("#tmc-approvals-toolbar");
    if (!host) {
      host = document.createElement("div");
      host.id = "tmc-approvals-toolbar";
      host.className = "card";
      host.style.background = "#eff6ff";
      host.style.borderColor = "#bfdbfe";
      host.innerHTML =
        '<div class="card-title">Select Quote to Approve</div>' +
        '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
          '<select id="tmc-approval-select" style="flex:1;min-width:300px;padding:8px;border:1px solid var(--border);border-radius:4px"></select>' +
          '<button class="btn" data-approval-act="draft">Back to Draft</button>' +
          '<button class="btn" data-approval-act="proceed">Submit for Approval</button>' +
          '<button class="btn btn-primary" data-approval-act="approved">Approve</button>' +
          '<button class="btn btn-warn" data-approval-act="rejected">Reject</button>' +
        '</div>' +
        '<div id="tmc-approval-status" style="margin-top:10px;font-size:13px;color:var(--muted);min-height:18px;padding:6px 10px;border-radius:4px"></div>';
      sec.insertBefore(host, sec.children[1]);  // right after view-header
      host.addEventListener("click", onApprovalAction);

      // Also wire the static header button (Approve as L2 →) and the inline
      // Approve / Reject / Request Changes buttons so clicking them works.
      sec.querySelectorAll("button").forEach(function (b) {
        if (b.closest("#tmc-approvals-toolbar")) return; // already wired
        var t = (b.textContent || "").toLowerCase();
        if (/approve/.test(t)) {
          b.setAttribute("data-approval-act", "approved");
          b.addEventListener("click", onApprovalAction);
        } else if (/reject/.test(t)) {
          b.setAttribute("data-approval-act", "rejected");
          b.addEventListener("click", onApprovalAction);
        } else if (/request changes/.test(t) || /back to draft/.test(t)) {
          b.setAttribute("data-approval-act", "draft");
          b.addEventListener("click", onApprovalAction);
        } else if (/download approval log/.test(t) || /log/.test(t)) {
          b.addEventListener("click", function () { showApprovalLog(); });
        } else if (/post/.test(t)) {
          b.addEventListener("click", async function () {
            var input = b.parentElement && b.parentElement.querySelector('input[type="text"]');
            var msg = input && input.value;
            if (!msg) return;
            var id = getApprovalQuoteId();
            if (!id) { alert("Pick a quote first."); return; }
            try {
              // post a chatter comment via Odoo message_post
              await apiPost("/api/quote/comment", { id: id, body: msg });
              input.value = "";
              setApprovalStatus("✓ Comment posted to Odoo chatter.", "ok");
            } catch (err) { setApprovalStatus("✗ " + err.message, "err"); }
          });
        }
      });
    }

    markPipelineAllApproved();

    try {
      var res = await apiGet("/api/approvals_pending");
      var rows = res.rows || [];
      var sel = host.querySelector("#tmc-approval-select");
      if (sel) {
        var curId = TMC.currentQuoteId;
        if (!rows.length) {
          sel.innerHTML = '<option value="">— no pending quotes —</option>';
        } else {
          sel.innerHTML = rows.map(function (q) {
            var cust = Array.isArray(q.customer_id) ? q.customer_id[1] : "—";
            var tag = "[" + (STATE_MAP[q.status] ? STATE_MAP[q.status].label : q.status) + "]";
            return '<option value="' + q.id + '"' + (q.id === curId ? " selected" : "") + '>' +
              esc(q.name + " · " + cust + " · margin " + Number(q.margin || 0).toFixed(1) + "% · " + tag) +
              '</option>';
          }).join("");
        }
        if (!curId && rows.length) {
          TMC.currentQuoteId = rows[0].id;
          sel.value = rows[0].id;
        }
      }
    } catch (err) {
      setApprovalStatus("Load failed: " + err.message, "err");
    }
  }

  function getApprovalQuoteId() {
    var sel = document.getElementById("tmc-approval-select");
    return sel && sel.value ? parseInt(sel.value, 10) : (TMC.currentQuoteId || null);
  }

  function openModal(html) {
    var old = document.getElementById("tmc-modal");
    if (old) old.remove();
    var root = document.createElement("div");
    root.id = "tmc-modal";
    root.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:99999;display:flex;align-items:flex-start;justify-content:center;padding:40px 20px;overflow:auto";
    root.innerHTML =
      '<div style="background:#fff;max-width:900px;width:100%;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,0.35);overflow:hidden">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 18px;background:var(--brand);color:#fff">' +
          '<strong id="tmc-modal-title">Log</strong>' +
          '<div>' +
            '<button class="btn btn-sm" id="tmc-modal-download" style="margin-right:6px">Download .txt</button>' +
            '<button class="btn btn-sm" id="tmc-modal-close">Close</button>' +
          '</div>' +
        '</div>' +
        '<div id="tmc-modal-body" style="padding:18px;max-height:70vh;overflow:auto">' + html + '</div>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener("click", function (e) {
      if (e.target === root || e.target.id === "tmc-modal-close") root.remove();
    });
  }

  async function showApprovalLog() {
    var id = getApprovalQuoteId();
    if (!id) { alert("Pick a quote from the dropdown first."); return; }
    openModal('<div class="muted">Loading log for quote id ' + id + '…</div>');
    document.getElementById("tmc-modal-title").textContent = "Approval / Audit Log · Quote " + id;
    try {
      var res = await apiGet("/api/quote/logs?id=" + id);
      var entries = res.entries || [];
      var body = document.getElementById("tmc-modal-body");
      if (!entries.length) {
        body.innerHTML = '<div class="muted" style="text-align:center;padding:30px">No log entries yet for this quote in Odoo chatter.</div>';
      } else {
        body.innerHTML = entries.map(function (e) {
          var changes = "";
          if (e.changes && e.changes.length) {
            changes =
              '<table class="grid" style="font-size:11px;margin-top:8px"><thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>' +
              e.changes.map(function (c) {
                return '<tr><td>' + esc(c.field) + '</td><td>' + esc(String(c.before == null ? "—" : c.before)) + '</td><td>' + esc(String(c.after == null ? "—" : c.after)) + '</td></tr>';
              }).join("") + '</tbody></table>';
          }
          return (
            '<div style="border-left:3px solid var(--accent);padding:10px 14px;margin-bottom:12px;background:#f8fafc;border-radius:4px">' +
              '<div style="display:flex;justify-content:space-between;font-size:12px">' +
                '<strong>' + esc(e.author || "System") + '</strong>' +
                '<span class="muted">' + esc(e.date) + ' · ' + esc(e.type) + '</span>' +
              '</div>' +
              (e.subject ? '<div style="font-weight:600;margin-top:4px">' + esc(e.subject) + '</div>' : '') +
              '<div style="margin-top:4px;font-size:12px">' + (e.body || "<em>(no body)</em>") + '</div>' +
              changes +
            '</div>'
          );
        }).join("");
      }
      var dl = document.getElementById("tmc-modal-download");
      if (dl) {
        dl.onclick = function () {
          var lines = ["Approval / Audit Log · Quote " + id, "Exported: " + new Date().toISOString(), "=".repeat(60), ""];
          entries.forEach(function (e) {
            lines.push("[" + e.date + "] " + (e.author || "System") + " · " + e.type);
            if (e.subject) lines.push("Subject: " + e.subject);
            // strip html from body
            var txt = document.createElement("div"); txt.innerHTML = e.body || "";
            lines.push(txt.textContent.trim());
            if (e.changes && e.changes.length) {
              e.changes.forEach(function (c) { lines.push("  · " + c.field + ": " + c.before + "  →  " + c.after); });
            }
            lines.push("-".repeat(60));
          });
          var blob = new Blob([lines.join("\n")], { type: "text/plain" });
          var a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "quote_" + id + "_log.txt";
          document.body.appendChild(a); a.click(); a.remove();
        };
      }
    } catch (err) {
      document.getElementById("tmc-modal-body").innerHTML = '<div style="color:#dc2626">Failed to load log: ' + esc(err.message) + '</div>';
    }
  }

  function setApprovalStatus(msg, kind) {
    var el = document.getElementById("tmc-approval-status");
    if (!el) return;
    el.textContent = msg;
    if (kind === "ok") {
      el.style.background = "#d1fae5"; el.style.color = "#065f46";
    } else if (kind === "err") {
      el.style.background = "#fee2e2"; el.style.color = "#991b1b";
    } else if (kind === "warn") {
      el.style.background = "#fef3c7"; el.style.color = "#92400e";
    } else {
      el.style.background = ""; el.style.color = "var(--muted)";
    }
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function onApprovalAction(ev) {
    var btn = ev.currentTarget && ev.currentTarget.matches && ev.currentTarget.matches("[data-approval-act]")
      ? ev.currentTarget
      : (ev.target && ev.target.closest ? ev.target.closest("[data-approval-act]") : null);
    if (!btn) return;
    ev.preventDefault && ev.preventDefault();
    var action = btn.getAttribute("data-approval-act");
    var id = getApprovalQuoteId();
    if (!id) { alert("No quote selected. Open Approvals, pick a quote from the dropdown at the top."); return; }

    setApprovalStatus("Working — " + action + " on quote id " + id + " …", null);
    btn.disabled = true;
    try {
      await apiPost("/api/quote/action", { id: id, action: action });
      setApprovalStatus("✓ Action '" + action + "' applied to quote id " + id + ".", "ok");
      await loadDashboard();
      await renderApprovals();
    } catch (err) {
      // Special handling for Odoo margin band rejection when user tried 'proceed'
      if (action === "proceed" && /margin is not allowed/i.test(err.message)) {
        var go = confirm(
          "Odoo rejected 'Submit for Approval' because the margin doesn't match any approval band " +
          "configured in project.approval.level.\n\n" +
          "Do you want to mark this quote as APPROVED directly? (admin override)"
        );
        if (go) {
          try {
            await apiPost("/api/quote/action", { id: id, action: "approved" });
            setApprovalStatus("✓ Approved directly (admin override) — quote id " + id, "ok");
            await loadDashboard();
            await renderApprovals();
            return;
          } catch (err2) {
            setApprovalStatus("✗ " + err2.message, "err");
            alert("Direct approval also failed: " + err2.message);
            return;
          }
        }
      }
      setApprovalStatus("✗ " + err.message, "err");
      alert("Action failed: " + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // =====================================================================
  // NEW QUOTE · SAVE / GENERATE / PUSH
  // =====================================================================
  function collectNewQuotePayload() {
    var section = findNewQuoteSection();
    if (!section) return null;
    var cards = section.querySelectorAll(".card");
    var opp = cards[0], budget = cards[1];
    function val(el) { return el ? (el.value || "").trim() : ""; }
    var custSel = opp ? opp.querySelector('select[data-role="customer"]') || opp.querySelectorAll("select")[0] : null;
    var leadSel = opp ? opp.querySelector('select[data-role="lead"]') || opp.querySelectorAll("select")[1] : null;

    // Pick inputs by TYPE so the injected #tmc-new-customer-name doesn't shift positions.
    var projInput = opp ? opp.querySelector('input[type="text"]:not(#tmc-new-customer-name)') : null;
    var durInput = opp ? opp.querySelector('input[type="number"]') : null;
    var startInput = opp ? opp.querySelector('input[type="month"]') : null;

    var projectName = val(projInput);
    var duration = parseInt(val(durInput) || "0", 10) || 0;
    var startMonth = val(startInput);  // YYYY-MM
    var startDate = null, endDate = null;
    if (/^\d{4}-\d{2}$/.test(startMonth)) {
      startDate = startMonth + "-01";
      if (duration > 0) {
        var d = new Date(startDate);
        d.setMonth(d.getMonth() + duration);
        endDate = d.toISOString().slice(0, 10);
      }
    }

    var bInputs = budget ? budget.querySelectorAll('input[type="number"]') : [];
    // In Section 2: [0] Budget Amount, [1] Target Margin %, [2] CTC Increment Factor
    var margin = parseFloat(val(bInputs[1]) || "0") || 0;

    // resource lines from TMC.resources (expand count)
    // monthly_cost pushed to Odoo = effective (override if user set one, else Odoo default)
    var resourceLines = [];
    TMC.resources.forEach(function (r) {
      var eff = effectiveMonthlyCost(r);
      for (var c = 0; c < (r.count || 1); c++) {
        resourceLines.push({
          skill_id: r.skill_id || null,
          level_id: r.level_id || null,
          monthly_cost: eff,
          ctc_factor: 15,
          alloc_pct: r.alloc_pct || 100,
          duration: r.duration || duration || 0,
        });
      }
    });

    var costLines = [];
    var dcTable = document.getElementById("directCostsTable");
    if (dcTable) {
      dcTable.querySelectorAll("tbody tr").forEach(function (tr) {
        var unit = parseFloat((tr.querySelector("td.dc-unit") || {}).textContent) || 0;
        var qty = parseFloat((tr.querySelector("td.dc-qty") || {}).textContent) || 0;
        var amount = unit * qty;
        if (amount > 0) costLines.push({ cost_type: "direct", amount: amount });
      });
    }

    var newCustName = "";
    var newCustEl = document.getElementById("tmc-new-customer-name");
    if (newCustEl && custSel && custSel.value === "__new__") {
      newCustName = (newCustEl.value || "").trim();
    }
    var cust_id = (custSel && custSel.value && custSel.value !== "__new__")
      ? parseInt(custSel.value, 10) || null
      : null;

    return {
      customer_id: cust_id,
      customer_name: newCustName || null,
      opportunity_id: leadSel && leadSel.value ? parseInt(leadSel.value, 10) : null,
      project_name: projectName || "Web-authored quote",
      project_duration: duration,
      start_date: startDate,
      end_date: endDate,
      margin: margin,
      location: "lhr",
      create_analytic: true,
      resource_lines: resourceLines,
      cost_lines: costLines,
    };
  }

  async function handleSaveNewQuote(ev) {
    ev && ev.preventDefault();
    var payload = collectNewQuotePayload();
    if (!payload) return;
    if (!payload.customer_id && !payload.customer_name) {
      alert("Please pick a customer from the dropdown, or choose '➕ Add new' and type a new customer name.");
      return;
    }
    var btn = ev && ev.currentTarget;
    var original = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Saving to Odoo..."; }
    try {
      var res = await apiPost("/api/quote/create", payload);
      var extra = "";
      if (res.customer_id && payload.customer_name) extra += "\nCreated customer · Odoo partner id " + res.customer_id;
      if (res.analytic_account_id) extra += "\nCreated analytic account · id " + res.analytic_account_id;
      alert("Saved to Odoo — " + (res.record ? res.record.name : ("id " + res.id)) + extra);
      TMC.currentQuoteId = res.id;
      // refresh partner dropdown so the newly created customer appears
      await populateTopDropdowns();
      await loadDashboard();
      var builderNav = document.querySelector('[data-view="builder"]');
      if (builderNav) builderNav.click();
    } catch (err) {
      alert("Save failed: " + err.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  function wireNewQuoteButtons() {
    var section = findNewQuoteSection();
    if (!section) return;
    var actions = section.querySelectorAll(".view-header .actions button");
    actions.forEach(function (btn) {
      var txt = (btn.textContent || "").toLowerCase();
      if (txt.indexOf("save draft") >= 0) {
        btn.addEventListener("click", handleSaveNewQuote);
      } else if (txt.indexOf("generate") >= 0) {
        btn.addEventListener("click", handleSaveNewQuote);
      }
    });
  }

  function wirePushButton() {
    var section = document.getElementById("view-push");
    if (!section) return;
    var actions = section.querySelectorAll(".view-header .actions button");
    actions.forEach(function (btn) {
      var t = (btn.textContent || "").toLowerCase();
      if (t.indexOf("push") >= 0 && t.indexOf("preview") < 0) {
        btn.addEventListener("click", async function () {
          var payload = collectNewQuotePayload() || {};
          if (!payload.customer_id && !payload.customer_name && TMC.partners.length) {
            payload.customer_id = TMC.partners[0].id;
          }
          if (!payload.customer_id && !payload.customer_name) {
            alert("No customer selected. Open 'New Quote' first, choose a customer from the dropdown or '➕ Add new'.");
            return;
          }
          payload.project_name = payload.project_name || "Pushed from Web App";
          payload.project_duration = payload.project_duration || 6;
          payload.create_analytic = true;
          btn.disabled = true;
          var orig = btn.textContent;
          btn.textContent = "Pushing...";
          try {
            var res = await apiPost("/api/quote/create", payload);
            var extra = "";
            if (res.customer_id && payload.customer_name) extra += "\nNew customer created · partner id " + res.customer_id;
            if (res.analytic_account_id) extra += "\nAnalytic account created · id " + res.analytic_account_id;
            alert("Pushed to Odoo.\n\nQuote: " + (res.record && res.record.name) + "\nOdoo ID: " + res.id + extra);
            TMC.currentQuoteId = res.id;
            await populateTopDropdowns();
            await loadDashboard();
            await renderApprovals();
            var nav = document.querySelector('[data-view="dashboard"]');
            if (nav) nav.click();
          } catch (err) {
            alert("Push failed: " + err.message);
          } finally {
            btn.disabled = false;
            btn.textContent = orig;
          }
        });
      }
    });
  }

  // -- Submit for L1 Approval button (inside Quote Builder header)
  function wireSubmitApprovalButton() {
    var btn = document.querySelector('#view-builder .view-header .actions button.btn-warn');
    if (!btn) return;
    btn.addEventListener("click", async function () {
      if (!TMC.currentQuoteId) {
        alert("Save the quote first (New Quote → Save Draft / Generate Quote).");
        return;
      }
      try {
        await apiPost("/api/quote/action", { id: TMC.currentQuoteId, action: "proceed" });
        alert("Submitted for approval (quote id " + TMC.currentQuoteId + ").");
        await renderApprovals();
        var nav = document.querySelector('[data-view="approvals"]');
        if (nav) nav.click();
      } catch (err) { alert(err.message); }
    });
  }

  // =====================================================================
  // CLEAR DEMO / HARDCODED DATA — runs once at boot + on "+ New Quote" click
  // =====================================================================
  function clearDashboardDemo() {
    var sec = document.getElementById("view-dashboard");
    if (!sec) return;
    // Wipe the 8 hardcoded quote rows so only Odoo data shows.
    var tbody = sec.querySelector(".card table.grid tbody");
    if (tbody) tbody.innerHTML =
      '<tr><td colspan="10" style="text-align:center;color:#64748b;padding:20px">Loading quotations from Odoo…</td></tr>';
    // Reset KPI cards to placeholder — loadDashboard will fill in
    var kpiCards = sec.querySelectorAll("div.row .card");
    kpiCards.forEach(function (card, i) {
      var v = card.querySelector("div:nth-child(2)");
      if (v) v.textContent = (i === 2) ? "PKR 0" : (i === 3 ? "—" : "0");
    });
  }

  function clearNewQuoteForm() {
    var sec = findNewQuoteSection();
    if (!sec) return;
    // Clear every text/number/month input inside New Quote
    sec.querySelectorAll('input[type="text"], input[type="number"], input[type="month"], input[type="date"]').forEach(function (inp) {
      if (inp.id === "tmc-new-customer-name") { inp.value = ""; return; }
      inp.value = "";
    });
    // Reset selects to first option (except our dynamically-filled customer/lead which populateTopDropdowns handles)
    var cards = sec.querySelectorAll(".card");
    // Section 2 selects: Pre-Budget, Costing Basis, Skill Rate Selector — leave at option[0]
    if (cards[1]) {
      cards[1].querySelectorAll("select").forEach(function (s) {
        s.selectedIndex = 0;
      });
    }

    // Wipe Section 3 resource list
    TMC.resources = [];
    renderResourceTable();

    // Wipe Section 5 Direct Costs extra rows (keep first empty row for user to fill)
    var dc = document.getElementById("directCostsTable");
    if (dc) {
      var dcBody = dc.querySelector("tbody");
      if (dcBody) {
        dcBody.innerHTML = '';
      }
      var dcGrand = document.getElementById("dcGrand");
      if (dcGrand) dcGrand.textContent = "0";
    }

    // Reset trip counts
    var loc = document.getElementById("localTripCount");
    var intl = document.getElementById("intlTripCount");
    if (loc) loc.value = "0";
    if (intl) intl.value = "0";
    var grandTravel = document.getElementById("grandTravelTotal");
    if (grandTravel) grandTravel.textContent = "0";

    // Hide the "new customer" box unless user re-opens it
    var box = document.getElementById("tmc-new-customer-wrap");
    if (box) box.style.display = "none";

    // Reset TMC state tied to this quote
    TMC.budget = 0;
    TMC.currentQuoteId = null;

    // Re-render dependent views
    renderBuilderGrid();
    updateBuilderKpis();
    // Reset scenarios baseline so next time user starts fresh
    TMC.scenarios = [];
    seedBaselineScenario();
    renderScenarios();
  }

  function clearBuilderDemo() {
    // Quote Builder grid is entirely regenerated by renderBuilderGrid() from TMC.resources.
    // Nothing extra to do — ensuring resources is empty handles it.
  }

  function clearPushDemo() {
    var sec = document.getElementById("view-push");
    if (!sec) return;
    // Blank out the 'Approved Payload Summary' hardcoded table — keep labels, clear values.
    var summary = sec.querySelector(".card table.grid");
    if (summary) {
      summary.querySelectorAll("tr").forEach(function (tr) {
        var tds = tr.querySelectorAll("td");
        if (tds.length >= 2) tds[1].textContent = "—";
      });
    }
    // Hide the 'Post-Push Confirmation Preview' card (hardcoded demo Odoo SO numbers/URL)
    sec.querySelectorAll(".card").forEach(function (card) {
      var strong = card.querySelector("strong");
      if (strong && /post-push confirmation preview/i.test(strong.textContent)) {
        card.style.display = "none";
      }
    });
  }

  function wireNewQuoteNavReset() {
    var nav = document.querySelector('.nav-item[data-view="newquote"]');
    if (!nav) return;
    nav.addEventListener("click", function () {
      // Only reset when user explicitly clicks "+ New Quote" to author a fresh one.
      clearNewQuoteForm();
    });
  }

  // =====================================================================
  // HIDE MENUS (Payment Plan, Versions) + nav badges per user request
  // =====================================================================
  function hideSidebarMenus() {
    var hide = ["payment", "versions"];
    hide.forEach(function (v) {
      var nav = document.querySelector('.nav-item[data-view="' + v + '"]');
      if (nav) nav.style.display = "none";
    });
    // Remove all count badges from sidebar (Scenarios had "3", etc.)
    document.querySelectorAll(".nav-item .nav-badge").forEach(function (b) {
      b.style.display = "none";
    });
  }

  // =====================================================================
  // APPROVAL PIPELINE — mark all stages as approved (demo mode)
  // =====================================================================
  function markPipelineAllApproved() {
    var sec = document.getElementById("view-approvals");
    if (!sec) return;
    // Find the "Approval Pipeline" card
    var pipelineCard = null;
    sec.querySelectorAll(".card").forEach(function (c) {
      var title = c.querySelector(".card-title");
      if (title && /approval pipeline/i.test(title.textContent)) pipelineCard = c;
    });
    if (!pipelineCard) return;

    // All circle avatars (44x44) → green with ✓
    pipelineCard.querySelectorAll('div[style*="width:44px"]').forEach(function (d) {
      d.style.background = "var(--accent)";
      d.style.color = "#fff";
      d.innerHTML = "&#10003;";
    });
    // All horizontal separators (height:3px) → green
    pipelineCard.querySelectorAll('div[style*="height:3px"]').forEach(function (d) {
      d.style.background = "var(--accent)";
    });
    // Stage labels — drop amber/muted colouring
    pipelineCard.querySelectorAll("div").forEach(function (d) {
      var s = d.getAttribute("style") || "";
      if (/color:var\(--warn\)/i.test(s)) {
        d.style.color = "var(--brand)";
      }
      if (/color:var\(--muted\)/i.test(s) && /font-weight:600/i.test(s)) {
        d.style.color = "var(--brand)";
      }
    });
    // Replace "Pending" / "Not started" sub-labels with "Approved"
    pipelineCard.querySelectorAll(".muted").forEach(function (d) {
      var t = (d.textContent || "").toLowerCase();
      if (/pending|not started|—/.test(t) && !/·/.test(t)) return; // keep name · date lines
      if (/pending/i.test(t)) d.innerHTML = d.innerHTML.replace(/Pending/i, "Approved");
      if (/not started/i.test(t)) d.innerHTML = d.innerHTML.replace(/Not started/i, "Approved");
    });
  }

  function wireBudgetInput() {
    var sec = findNewQuoteSection();
    if (!sec) return;
    var bCard = sec.querySelectorAll(".card")[1];
    if (!bCard) return;
    var bInputs = bCard.querySelectorAll("input");
    if (!bInputs.length) return;
    bInputs[0].addEventListener("input", function () {
      TMC.budget = pullBudgetFromForm();
      updateBuilderKpis();
    });
  }

  // =====================================================================
  // BOOT
  // =====================================================================
  async function boot() {
    try {
      var ping = await apiGet("/api/ping");
      setBadge("connected · " + ping.db + " (uid " + ping.uid + ")", "#34d399");
    } catch (err) {
      setBadge("offline — " + err.message, "#f87171");
    }
    hideSidebarMenus();
    // Wipe every static demo value BEFORE anything renders.
    clearDashboardDemo();
    clearPushDemo();
    await populateTopDropdowns();
    await loadSkillsAndLevels();
    // Force the New Quote form to a blank state (no SABIC / 45M / 6-month seed).
    clearNewQuoteForm();
    wireAddRowButton();
    wireMarginSlider();
    wireBudgetInput();
    wireNewQuoteNavReset();
    renderBuilderGrid();
    updateBuilderKpis();
    wireSaveScenarioButton();

    // Re-render grid when duration input changes
    var sec = findNewQuoteSection();
    if (sec) {
      var oppCard = sec.querySelectorAll(".card")[0];
      var durInput = oppCard ? oppCard.querySelectorAll('input[type="number"]')[0] : null;
      if (durInput) durInput.addEventListener("change", function () { renderBuilderGrid(); updateBuilderKpis(); });
      var startInput = oppCard ? oppCard.querySelector('input[type="month"]') : null;
      if (startInput) startInput.addEventListener("change", function () { renderBuilderGrid(); });
    }

    await loadDashboard();
    await renderApprovals();
    wireNewQuoteButtons();
    wirePushButton();
    wireDashboardOpen();
    wireSubmitApprovalButton();

    // refresh Builder totals whenever direct costs / travel change
    document.addEventListener("input", function (e) {
      var t = e.target;
      if (!t || !t.classList) return;
      if (t.closest && (t.closest("#directCostsTable") || t.closest("#localTravelTable") || t.closest("#intlTravelTable") || t.id === "localTripCount" || t.id === "intlTripCount")) {
        // let existing inline scripts run first, then propagate
        setTimeout(function () { renderBuilderGrid(); updateBuilderKpis(); }, 30);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
