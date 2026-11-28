const CLIENT_HELPERS_JS = `
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const byId = (id) => document.getElementById(id);
  const pill = (text, cls) => '<span class="flk-pill ' + (cls || "") + '">' + esc(text) + '</span>';
  const DATA = JSON.parse(byId("featlock-data").textContent || "{}");
  window.FEATLOCK_DATA = DATA;
  const state = { tab: "overview", featQuery: "", invQuery: "", invRung: "all", selectedFeature: (DATA.registry?.features?.[0]?.id) || "" };`;

const OVERVIEW_JS = `
  function renderFenceSvg(dist) {
    const rows = [["R0", dist.R0, "var(--ok)"], ["R1", dist.R1, "var(--ok)"], ["R2", dist.R2, "var(--accent)"], ["R3", dist.R3, "var(--accent)"], ["runtime", dist.runtime, "var(--warn)"], ["none", dist.none, "var(--danger)"]];
    const max = Math.max(1, ...rows.map((r) => r[1]));
    const bars = rows.map((r, i) => {
      const y = 12 + i * 28;
      const w = Math.max(2, Math.round((r[1] / max) * 320));
      return '<text x="4" y="' + (y + 14) + '" fill="var(--muted)" font-size="12" font-family="var(--font-mono)">' + r[0] + '</text>' +
        '<rect x="78" y="' + y + '" width="' + w + '" height="18" rx="4" fill="' + r[2] + '"/>' +
        '<text x="' + (86 + w) + '" y="' + (y + 14) + '" fill="var(--text)" font-size="12" font-family="var(--font-mono)">' + r[1] + '</text>';
    }).join("");
    return '<svg width="450" height="190" viewBox="0 0 450 190" role="img" aria-label="Fence rung distribution">' + bars + '</svg>';
  }
  function renderOverview() {
    const c = DATA.counts || { features: 0, tests: 0, invariants: 0, auditEntries: 0 };
    const dist = DATA.fenceDistribution || { R0: 0, R1: 0, R2: 0, R3: 0, runtime: 0, none: 0, bugfixOrigin: 0, superseded: 0 };
    const ok = Boolean(DATA.check?.ok);
    byId("panel-overview-core").innerHTML =
      '<div class="flk-grid">' +
        '<div class="flk-card"><h3>Features</h3><div class="flk-kpi">' + c.features + '</div></div>' +
        '<div class="flk-card"><h3>Linked Tests</h3><div class="flk-kpi">' + c.tests + '</div></div>' +
        '<div class="flk-card"><h3>Locked Invariants</h3><div class="flk-kpi">' + c.invariants + '</div></div>' +
        '<div class="flk-card"><h3>Guard Status</h3><div class="flk-kpi ' + (ok ? "flk-ok" : "flk-danger") + '">' + (ok ? "PASS" : "FAIL") + '</div><div class="flk-meta">' + (DATA.check?.violations?.length || 0) + ' err · ' + (DATA.check?.warnings?.length || 0) + ' warn</div></div>' +
        '<div class="flk-card"><h3>Bugfix-Origin</h3><div class="flk-kpi">' + dist.bugfixOrigin + '</div><div class="flk-meta">' + dist.superseded + ' superseded</div></div>' +
      '</div>' +
      '<div class="flk-card"><h3>Fence Strength Distribution (R0 → none)</h3>' + renderFenceSvg(dist) + '</div>';
  }`;

const CATALOG_JS = `
  function renderFeatures() {
    const q = state.featQuery.toLowerCase();
    const testsByFeat = new Map();
    for (const t of (DATA.registry?.tests || [])) {
      const list = testsByFeat.get(t.featureId) || [];
      list.push(t);
      testsByFeat.set(t.featureId, list);
    }
    const rows = (DATA.registry?.features || []).filter((f) => !q || (f.id + " " + f.name + " " + f.area + " " + f.summary).toLowerCase().includes(q));
    byId("features-tbody").innerHTML = rows.map((f) => {
      const tCount = (testsByFeat.get(f.id) || []).length;
      const cls = f.status === "active" ? "ok" : f.status === "deprecated" ? "warn" : "danger";
      return '<tr><td class="flk-mono">' + esc(f.id) + '</td><td><strong>' + esc(f.name) + '</strong><div class="flk-meta">' + esc(f.summary) + '</div></td><td>' + pill(f.area) + '</td><td>' + pill(f.status, cls) + '</td><td class="flk-mono">' + tCount + '</td></tr>';
    }).join("") || '<tr><td colspan="5" class="flk-meta">No matching features.</td></tr>';
  }
  function renderInvariants() {
    const q = state.invQuery.toLowerCase();
    const rows = (DATA.registry?.invariants || []).filter((inv) => {
      const rung = inv.fenceRung || "none";
      if (state.invRung !== "all" && rung !== state.invRung) return false;
      return !q || (inv.id + " " + inv.featureId + " " + inv.statement + " " + inv.file).toLowerCase().includes(q);
    });
    byId("invariants-tbody").innerHTML = rows.map((inv) => {
      const rung = inv.fenceRung || "none";
      const rCls = rung === "R0" || rung === "R1" ? "ok" : rung === "none" ? "danger" : "warn";
      const bug = inv.originKind === "bugfix" ? " " + pill("bugfix", "warn") : "";
      const sup = inv.supersededBy ? '<div class="flk-meta">superseded by: ' + esc(inv.supersededBy) + '</div>' : "";
      return '<tr><td class="flk-mono">' + esc(inv.id) + '</td><td>' + pill(rung, rCls) + bug + '</td><td>' + esc(inv.statement) + sup + '</td><td class="flk-mono">' + esc(inv.file) + ':' + inv.line + '</td><td>' + pill(inv.source) + '</td></tr>';
    }).join("") || '<tr><td colspan="5" class="flk-meta">No matching invariants.</td></tr>';
  }`;

const MATRIX_GRAPH_JS = `
  function renderMatrix() {
    const mat = DATA.matrix || { scattering: { dosByFeature: {}, highScattering: [], highTangling: [] }, interactions: [], flags: [] };
    const entries = Object.entries(mat.scattering?.dosByFeature || {}).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const maxDos = Math.max(1, ...entries.map((e) => e[1]));
    const bars = entries.map((e, i) => {
      const y = 10 + i * 24;
      const w = Math.max(4, Math.round((e[1] / maxDos) * 260));
      return '<text x="4" y="' + (y + 13) + '" fill="var(--muted)" font-size="11" font-family="var(--font-mono)">' + esc(e[0].slice(0, 26)) + '</text>' +
        '<rect x="210" y="' + y + '" width="' + w + '" height="16" rx="3" fill="var(--accent)"/>' +
        '<text x="' + (218 + w) + '" y="' + (y + 13) + '" fill="var(--text)" font-size="11" font-family="var(--font-mono)">' + e[1] + ' files</text>';
    }).join("");
    const svg = entries.length ? '<svg width="540" height="' + (entries.length * 24 + 20) + '">' + bars + '</svg>' : '<div class="flk-meta">No scattering data yet.</div>';
    const interRows = (mat.interactions || []).map((x) => '<tr><td class="flk-mono">' + esc(x.featureA) + '</td><td class="flk-mono">' + esc(x.featureB) + '</td><td class="flk-mono">' + esc((x.sharedVia || []).join(", ")) + '</td><td>' + pill(x.pairwiseGap ? "GAP" : "TESTED", x.pairwiseGap ? "warn" : "ok") + '</td></tr>').join("") || '<tr><td colspan="4" class="flk-meta">No shared-file feature interactions.</td></tr>';
    const flagRows = (mat.flags || []).map((f) => '<tr><td class="flk-mono">' + esc(f.flag) + '</td><td class="flk-mono">' + esc(f.file) + ':' + f.line + '</td><td>' + pill(f.status, f.status === "linked" ? "ok" : "warn") + '</td></tr>').join("") || '<tr><td colspan="3" class="flk-meta">No feature flags detected.</td></tr>';
    byId("panel-matrix").innerHTML = '<div class="flk-card" style="margin-bottom:16px"><h3>Degree of Scattering (DoS)</h3>' + svg + '</div>' +
      '<div class="flk-card" style="margin-bottom:16px"><h3>Pairwise Feature Interactions</h3><table class="flk-table"><thead><tr><th>Feature A</th><th>Feature B</th><th>Shared Files</th><th>Coverage</th></tr></thead><tbody>' + interRows + '</tbody></table></div>' +
      '<div class="flk-card"><h3>Feature Flag Audit</h3><table class="flk-table"><thead><tr><th>Flag</th><th>Location</th><th>Status</th></tr></thead><tbody>' + flagRows + '</tbody></table></div>';
  }
  function renderGraph() {
    const feats = (DATA.registry?.features || []).filter((f) => f.status === "active");
    if (!state.selectedFeature && feats[0]) state.selectedFeature = feats[0].id;
    const listHtml = feats.map((f) => '<button class="flk-list-item ' + (f.id === state.selectedFeature ? "active" : "") + '" data-select-feat="' + esc(f.id) + '"><div class="flk-mono">' + esc(f.id) + '</div><div class="flk-meta">' + esc(f.name) + '</div></button>').join("");
    const sub = (DATA.concernSubgraphs || {})[state.selectedFeature];
    const rels = (DATA.registry?.relations || []).filter((r) => r.fromFeatureId === state.selectedFeature || r.toFeatureId === state.selectedFeature);
    const detail = sub
      ? '<div class="flk-card"><h3>Concern Subgraph · ' + esc(state.selectedFeature) + '</h3>' +
          '<div class="flk-meta">Nodes: ' + sub.nodes.length + ' · Edges: ' + sub.edges.length + ' · Cross-boundary leaks: ' + sub.crossBoundaryLeaks.length + '</div>' +
          '<ul>' + sub.nodes.slice(0, 30).map((n) => '<li class="flk-mono">' + esc(n) + '</li>').join("") + '</ul>' +
          (rels.length ? '<h3>Relations</h3><ul>' + rels.map((r) => '<li class="flk-mono">' + esc(r.fromFeatureId) + ' —[' + esc(r.relation) + ']→ ' + esc(r.toFeatureId) + '</li>').join("") + '</ul>' : "") +
        '</div>'
      : '<div class="flk-card"><div class="flk-meta">Select a feature to inspect its concern subgraph.</div></div>';
    byId("panel-graph").innerHTML = '<div class="flk-split"><div>' + listHtml + '</div><div>' + detail + '</div></div>';
    for (const btn of byId("panel-graph").querySelectorAll("[data-select-feat]")) {
      btn.addEventListener("click", () => { state.selectedFeature = btn.getAttribute("data-select-feat") || ""; renderGraph(); });
    }
  }`;

const AUDIT_BOOT_JS = `
  function renderAudit() {
    const viols = [...(DATA.check?.violations || []), ...(DATA.check?.warnings || [])];
    const vHtml = viols.map((v) => '<tr><td>' + pill(v.severity, v.severity === "error" ? "danger" : "warn") + '</td><td class="flk-mono">' + esc(v.rule) + '</td><td>' + esc(v.message) + '</td><td class="flk-mono">' + esc(v.file || "-") + '</td></tr>').join("") || '<tr><td colspan="4" class="flk-ok">Zero guard violations or warnings.</td></tr>';
    const pHtml = (DATA.plugins || []).map((p) => '<tr><td class="flk-mono">' + esc(p.id) + '</td><td>' + pill(p.source) + '</td><td>' + pill(p.status, p.status === "active" ? "ok" : "danger") + '</td><td>' + (p.guarded ? pill("guarded", "ok") : "-") + '</td></tr>').join("");
    const aHtml = (DATA.registry?.auditLog || []).slice(-25).reverse().map((a) => '<tr><td class="flk-mono">' + esc(a.featureId) + '</td><td>' + pill(a.action) + '</td><td class="flk-mono">' + esc(a.actor) + '</td><td>' + esc(a.summary) + '</td></tr>').join("") || '<tr><td colspan="4" class="flk-meta">No audit entries yet.</td></tr>';
    byId("panel-audit").innerHTML =
      '<div class="flk-card" style="margin-bottom:16px"><h3>Guard Check Findings</h3><table class="flk-table"><thead><tr><th>Severity</th><th>Rule</th><th>Message</th><th>File</th></tr></thead><tbody>' + vHtml + '</tbody></table></div>' +
      '<div class="flk-card" style="margin-bottom:16px"><h3>Active Plugins</h3><table class="flk-table"><thead><tr><th>Plugin ID</th><th>Source</th><th>Status</th><th>Guarded</th></tr></thead><tbody>' + pHtml + '</tbody></table></div>' +
      '<div class="flk-card"><h3>Audit Trail</h3><table class="flk-table"><thead><tr><th>Feature</th><th>Action</th><th>Actor</th><th>Summary</th></tr></thead><tbody>' + aHtml + '</tbody></table></div>';
  }
  function setTab(id) {
    state.tab = id;
    for (const b of document.querySelectorAll("[data-tab-btn]")) b.classList.toggle("active", b.getAttribute("data-tab-btn") === id);
    for (const p of document.querySelectorAll("[data-tab-panel]")) p.classList.toggle("active", p.getAttribute("data-tab-panel") === id);
  }
  window.FeatlockStudio = { data: DATA, setTab, escapeHtml: esc };
  for (const b of document.querySelectorAll("[data-tab-btn]")) {
    b.addEventListener("click", () => setTab(b.getAttribute("data-tab-btn") || "overview"));
  }
  const themeBtn = byId("flk-theme-toggle");
  if (themeBtn) themeBtn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
  });
  const fSearch = byId("flk-feat-search");
  if (fSearch) fSearch.addEventListener("input", (e) => { state.featQuery = e.target.value || ""; renderFeatures(); });
  const iSearch = byId("flk-inv-search");
  if (iSearch) iSearch.addEventListener("input", (e) => { state.invQuery = e.target.value || ""; renderInvariants(); });
  const iRung = byId("flk-inv-rung");
  if (iRung) iRung.addEventListener("change", (e) => { state.invRung = e.target.value || "all"; renderInvariants(); });
  renderOverview(); renderFeatures(); renderInvariants(); renderMatrix(); renderGraph(); renderAudit(); setTab("overview");`;

export function renderStudioClientScript(): string {
  return `(() => {\n${CLIENT_HELPERS_JS}\n${OVERVIEW_JS}\n${CATALOG_JS}\n${MATRIX_GRAPH_JS}\n${AUDIT_BOOT_JS}\n})();`;
}
