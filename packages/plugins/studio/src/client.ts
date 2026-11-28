const CLIENT_BOOT_JS = `
  const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const byId = (id) => document.getElementById(id);
  const DATA = JSON.parse(byId("featlock-data").textContent || "{}");
  const MODEL = DATA.actionModel || { verdict: "", isLivePreview: false, counts: { broken: 0, fixNext: 0, structural: 0, holding: 0 }, items: [], defaultItemId: null };
  window.FEATLOCK_DATA = DATA;
  const state = {
    tab: "actions",
    tierFilter: "all",
    selectedActionId: MODEL.defaultItemId || "",
    featQuery: "",
    selectedFeatId: (DATA.registry?.features?.[0]?.id) || "",
  };
  const invByFeat = new Map();
  const testsByFeat = new Map();
  for (const inv of (DATA.registry?.invariants || [])) {
    const list = invByFeat.get(inv.featureId) || [];
    list.push(inv);
    invByFeat.set(inv.featureId, list);
  }
  for (const t of (DATA.registry?.tests || [])) {
    const list = testsByFeat.get(t.featureId) || [];
    list.push(t);
    testsByFeat.set(t.featureId, list);
  }`;

const ACTION_QUEUE_JS = `
  function renderEvidenceGroup(g) {
    const cap = 15;
    const rows = g.items.slice(0, cap).map((it) =>
      '<div class="flk-item-row"><div class="flk-mono"><strong>' + esc(it.title) + '</strong> · ' + esc(it.location) + '</div><div class="flk-meta">' + esc(it.detail) + '</div></div>'
    ).join("");
    const extra = g.items.length > cap ? '<div class="flk-meta" style="padding-top:8px">Showing first ' + cap + ' of ' + g.items.length + ' items in this group.</div>' : "";
    return '<details class="flk-details"' + (g.items.length <= 6 ? " open" : "") + '><summary><span>' + esc(g.groupLabel) + '</span><span class="flk-badge">' + g.count + '</span></summary>' + rows + extra + '</details>';
  }
  function renderActionDetail(item) {
    const el = byId("flk-action-detail");
    if (!item) {
      el.innerHTML = '<div class="flk-card"><h3>Everything Holding Strong</h3><div class="flk-guide-v">No open blockers or warnings match this filter. Select a feature in the Features tab or Protection Map to inspect its guards and tests.</div></div>';
      return;
    }
    const sourcesHtml = (item.sources || []).map((s) => '<a class="flk-src-link" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' + esc(s.label) + ' ↗</a>').join("");
    const groupsHtml = (item.groups || []).map(renderEvidenceGroup).join("");
    el.innerHTML =
      '<div><div style="font-size:22px;font-weight:700">' + esc(item.title) + '</div><div class="flk-meta">' + esc(item.subtitle) + '</div></div>' +
      '<div class="flk-guide-grid">' +
        '<div class="flk-guide-card"><div class="flk-guide-k">What Is Happening</div><div class="flk-guide-v">' + esc(item.what) + '</div></div>' +
        '<div class="flk-guide-card"><div class="flk-guide-k">Why It Matters</div><div class="flk-guide-v">' + esc(item.why) + '</div></div>' +
        '<div class="flk-guide-card"><div class="flk-guide-k">How to Fix It</div><div class="flk-guide-v">' + esc(item.fix) + '</div></div>' +
        '<div class="flk-guide-card is-good"><div class="flk-guide-k">Why This Change Helps</div><div class="flk-guide-v">' + esc(item.benefit) + '</div></div>' +
      '</div>' +
      '<div class="flk-cmd-bar"><code class="flk-mono">' + esc(item.cliCommand) + '</code><button class="flk-btn" data-copy-cmd="' + esc(item.cliCommand) + '" type="button">Copy command</button></div>' +
      (sourcesHtml ? '<div><div class="flk-tier-h">Research & Engineering Sources</div><div class="flk-sources">' + sourcesHtml + '</div></div>' : "") +
      '<div><div class="flk-tier-h">Affected Areas & Evidence (' + item.count + ')</div>' + groupsHtml + '</div>';
    for (const btn of el.querySelectorAll("[data-copy-cmd]")) {
      btn.addEventListener("click", () => {
        if (navigator.clipboard) void navigator.clipboard.writeText(btn.getAttribute("data-copy-cmd") || "");
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = "Copy command"; }, 1400);
      });
    }
  }
  function renderActionQueue() {
    const items = (MODEL.items || []).filter((i) => state.tierFilter === "all" || i.tier === state.tierFilter);
    if (!items.some((i) => i.id === state.selectedActionId)) state.selectedActionId = items[0]?.id || "";
    const tiers = [["broken", "Broken / Blocking", "err"], ["fix_next", "Fix Next (High Leverage)", "warn"], ["structural", "Structural & Fence Upgrades", "info"]];
    let leftHtml = "";
    for (const [tierKey, label, dot] of tiers) {
      const subset = items.filter((i) => i.tier === tierKey);
      if (subset.length === 0) continue;
      leftHtml += '<div><div class="flk-tier-h"><span class="flk-dot ' + dot + '"></span>' + label + ' (' + subset.length + ')</div>' +
        subset.map((it) => '<button class="flk-tile ' + (it.id === state.selectedActionId ? "active" : "") + '" data-action-id="' + esc(it.id) + '" type="button"><div class="flk-tile-top"><span class="flk-tile-title">' + esc(it.title) + '</span><span class="flk-tile-cnt">' + it.count + '</span></div><div class="flk-tile-sub">' + esc(it.subtitle) + '</div></button>').join("") +
      '</div>';
    }
    byId("flk-action-list").innerHTML = leftHtml || '<div class="flk-card"><div class="flk-meta">No open items in this filter.</div></div>';
    for (const b of byId("flk-action-list").querySelectorAll("[data-action-id]")) {
      b.addEventListener("click", () => { state.selectedActionId = b.getAttribute("data-action-id") || ""; renderActionQueue(); });
    }
    for (const k of document.querySelectorAll("[data-tier-filter]")) {
      k.classList.toggle("active", k.getAttribute("data-tier-filter") === state.tierFilter);
    }
    renderActionDetail(items.find((i) => i.id === state.selectedActionId) || null);
  }`;

const FEATURES_AND_MAP_JS = `
  function renderFeaturesView() {
    const q = state.featQuery.toLowerCase();
    const feats = (DATA.registry?.features || []).filter((f) => !q || (f.area + " " + f.name + " " + f.id + " " + f.summary).toLowerCase().includes(q));
    if (!feats.some((f) => f.id === state.selectedFeatId)) state.selectedFeatId = feats[0]?.id || "";
    const buckets = [
      ["Apps", feats.filter((f) => f.area.startsWith("app:"))],
      ["Plugins & Packages", feats.filter((f) => !f.area.startsWith("app:") && f.area !== "core" && f.area !== "src")],
      ["Core & Other", feats.filter((f) => f.area === "core" || f.area === "src")],
    ];
    byId("flk-feat-groups").innerHTML = buckets.filter((b) => b[1].length > 0).map(([title, list]) =>
      '<details class="flk-details" open><summary><span>' + esc(title) + '</span><span class="flk-badge">' + list.length + '</span></summary>' +
        list.map((f) => {
          const ic = (invByFeat.get(f.id) || []).length;
          const tc = (testsByFeat.get(f.id) || []).length;
          return '<button class="flk-tile ' + (f.id === state.selectedFeatId ? "active" : "") + '" style="margin-top:8px" data-feat-id="' + esc(f.id) + '" type="button"><div class="flk-tile-top"><span class="flk-tile-title">' + esc(f.area.replace(/^app:/, "")) + '</span><span class="flk-badge">' + ic + ' guards · ' + tc + ' tests</span></div><div class="flk-tile-sub">' + esc(f.summary) + '</div></button>';
        }).join("") +
      '</details>'
    ).join("") || '<div class="flk-meta">No matching features.</div>';
    for (const b of byId("flk-feat-groups").querySelectorAll("[data-feat-id]")) {
      b.addEventListener("click", () => { state.selectedFeatId = b.getAttribute("data-feat-id") || ""; renderFeaturesView(); });
    }
    const sel = feats.find((f) => f.id === state.selectedFeatId);
    if (!sel) { byId("flk-feat-detail").innerHTML = '<div class="flk-meta">Select a feature to inspect.</div>'; return; }
    const invs = invByFeat.get(sel.id) || [];
    const tests = testsByFeat.get(sel.id) || [];
    const dos = (DATA.matrix?.scattering?.dosByFeature || {})[sel.id] || 0;
    const byFile = new Map();
    for (const inv of invs) {
      const list = byFile.get(inv.file) || [];
      list.push(inv);
      byFile.set(inv.file, list);
    }
    const fileGroupsHtml = Array.from(byFile.entries()).map(([file, list]) =>
      '<details class="flk-details"><summary><span class="flk-mono">' + esc(file) + '</span><span class="flk-badge">' + list.length + '</span></summary>' +
        list.map((i) => '<div class="flk-item-row"><div class="flk-mono">L' + i.line + ' · <span class="flk-pill ' + (i.fenceRung === "R0" || i.fenceRung === "R1" ? "ok" : "warn") + '">' + esc(i.fenceRung || "none") + '</span>' + (i.originKind === "bugfix" ? ' <span class="flk-pill danger">bugfix</span>' : "") + '</div><div>' + esc(i.statement.replace(/^Precondition fail-closed guard:\\s*/, "")) + '</div></div>').join("") +
      '</details>'
    ).join("") || '<div class="flk-meta">No locked invariants in this area yet.</div>';
    const testsHtml = tests.slice(0, 20).map((t) => '<div class="flk-item-row"><span class="flk-mono">' + esc(t.testPath) + '</span><span class="flk-meta">' + esc(t.testPattern) + ' (' + esc(t.rung) + ')</span></div>').join("") || '<div class="flk-meta">No linked tests.</div>';
    const testsExtra = tests.length > 20 ? '<div class="flk-meta" style="padding-top:8px">Showing first 20 of ' + tests.length + ' linked tests.</div>' : "";
    byId("flk-feat-detail").innerHTML =
      '<div><div style="font-size:22px;font-weight:700">' + esc(sel.area) + '</div><div class="flk-meta flk-mono">' + esc(sel.id) + ' · ' + invs.length + ' locked guards · ' + tests.length + ' linked tests · spread across ' + dos + ' file(s)</div></div>' +
      '<div class="flk-guide-card"><div class="flk-guide-k">What This Capability Protects</div><div class="flk-guide-v">' + esc(sel.summary) + '</div></div>' +
      '<div><div class="flk-tier-h">Locked Safety Guards by File (' + invs.length + ')</div>' + fileGroupsHtml + '</div>' +
      '<details class="flk-details"><summary><span>Linked Tests</span><span class="flk-badge">' + tests.length + '</span></summary>' + testsHtml + testsExtra + '</details>';
  }
  function renderProtectionMap() {
    const feats = (DATA.registry?.features || []).map((f) => ({
      id: f.id,
      area: f.area.replace(/^app:/, ""),
      isApp: f.area.startsWith("app:"),
      invs: (invByFeat.get(f.id) || []).length,
      tests: (testsByFeat.get(f.id) || []).length,
      dos: (DATA.matrix?.scattering?.dosByFeature || {})[f.id] || 0,
    })).sort((a, b) => b.invs - a.invs || b.tests - a.tests);
    const maxInv = Math.max(1, ...feats.map((f) => f.invs));
    const h = Math.max(120, feats.length * 32 + 34);
    const rows = feats.map((f, i) => {
      const y = 24 + i * 32;
      const w = Math.max(4, Math.round((f.invs / maxInv) * 440));
      const fill = f.invs === 0 ? "var(--danger)" : f.dos >= 8 ? "var(--warn)" : "var(--accent)";
      return '<g style="cursor:pointer" data-jump-feat="' + esc(f.id) + '">' +
        '<text x="8" y="' + (y + 15) + '" fill="var(--text)" font-size="13" font-family="var(--font-mono)">' + esc(f.area.slice(0, 26)) + '</text>' +
        '<rect x="240" y="' + y + '" width="' + w + '" height="18" rx="4" fill="' + fill + '"/>' +
        '<text x="' + (252 + w) + '" y="' + (y + 15) + '" fill="var(--text-2)" font-size="13" font-family="var(--font-mono)">' + f.invs + ' guards · ' + f.dos + ' files · ' + f.tests + ' tests</text>' +
      '</g>';
    }).join("");
    byId("flk-map-svg").innerHTML = '<svg width="100%" height="' + h + '" viewBox="0 0 980 ' + h + '">' +
      '<text x="8" y="13" fill="var(--muted)" font-size="12" font-family="var(--font-mono)">AREA</text>' +
      '<text x="240" y="13" fill="var(--muted)" font-size="12" font-family="var(--font-mono)">LOCKED GUARDS & FILE SCATTERING (click any row to inspect)</text>' +
      rows + '</svg>';
    for (const g of byId("flk-map-svg").querySelectorAll("[data-jump-feat]")) {
      g.addEventListener("click", () => {
        state.selectedFeatId = g.getAttribute("data-jump-feat") || "";
        renderFeaturesView();
        setTab("features");
      });
    }
  }`;

const WIRING_JS = `
  function setTab(id) {
    state.tab = id;
    for (const b of document.querySelectorAll("[data-tab-btn]")) b.classList.toggle("active", b.getAttribute("data-tab-btn") === id);
    for (const p of document.querySelectorAll("[data-tab-panel]")) p.classList.toggle("active", p.getAttribute("data-tab-panel") === id);
  }
  window.FeatlockStudio = { data: DATA, actionModel: MODEL, setTab, escapeHtml: esc };
  for (const b of document.querySelectorAll("[data-tab-btn]")) b.addEventListener("click", () => setTab(b.getAttribute("data-tab-btn") || "actions"));
  for (const k of document.querySelectorAll("[data-tier-filter]")) {
    k.addEventListener("click", () => { state.tierFilter = k.getAttribute("data-tier-filter") || "all"; renderActionQueue(); });
  }
  const fSearch = byId("flk-feat-search");
  if (fSearch) fSearch.addEventListener("input", (e) => { state.featQuery = e.target.value || ""; renderFeaturesView(); });
  const themeBtn = byId("flk-theme-toggle");
  if (themeBtn) themeBtn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
  });
  const modal = byId("flk-guide-modal");
  const openGuide = byId("flk-guide-open");
  const closeGuide = byId("flk-guide-close");
  if (openGuide && modal) openGuide.addEventListener("click", () => modal.classList.add("open"));
  if (closeGuide && modal) closeGuide.addEventListener("click", () => modal.classList.remove("open"));
  if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("open"); });
  renderActionQueue(); renderFeaturesView(); renderProtectionMap(); setTab("actions");`;

export function renderStudioClientScript(): string {
  return `(() => {\n${CLIENT_BOOT_JS}\n${ACTION_QUEUE_JS}\n${FEATURES_AND_MAP_JS}\n${WIRING_JS}\n})();`;
}
