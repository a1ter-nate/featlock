import type { StudioRenderContext, StudioTabSpec } from "@featlock/plugin";
import { renderStudioClientScript } from "./client.ts";
import { buildActionModel, STUDIO_GLOSSARY, type ActionQueueModel } from "./guidance.ts";
import { renderStudioCss } from "./styles.ts";

export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function serializeDataForScript(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c").replace(/-->/g, "--\\>");
}

function resolveTabBadge(tab: StudioTabSpec, ctx: StudioRenderContext): string {
  if (!tab.badge) return "";
  const val = typeof tab.badge === "function" ? tab.badge(ctx.data) : tab.badge;
  return val ? `<span class="flk-badge">${escapeHtml(val)}</span>` : "";
}

function renderCustomWidgetsHtml(ctx: StudioRenderContext): string {
  if (ctx.widgets.length === 0) return "";
  const cards = ctx.widgets
    .map(
      (w) =>
        `<article class="flk-card" data-widget="${escapeHtml(w.id)}"><h3>${escapeHtml(w.title)}</h3>${w.renderHtml(ctx.data)}</article>`,
    )
    .join("\n");
  return `<section class="flk-grid" data-plugin-widgets="true">${cards}</section>`;
}

function renderNavButtons(ctx: StudioRenderContext, model: ActionQueueModel): string {
  const openCount = model.counts.broken + model.counts.fixNext + model.counts.structural;
  const builtinTabs: Array<{ id: string; label: string; badge?: string }> = [
    { id: "actions", label: "Action Queue", badge: String(openCount) },
    { id: "features", label: "Features", badge: String(ctx.data.counts.features) },
    { id: "map", label: "Protection Map", badge: String(ctx.data.counts.invariants) },
  ];
  const builtinHtml = builtinTabs
    .map(
      (t) =>
        `<button class="flk-tab-btn" data-tab-btn="${escapeHtml(t.id)}" type="button">${escapeHtml(t.label)}${t.badge ? `<span class="flk-badge">${escapeHtml(t.badge)}</span>` : ""}</button>`,
    )
    .join("");
  const pluginHtml = ctx.tabs
    .map(
      (t) =>
        `<button class="flk-tab-btn" data-tab-btn="${escapeHtml(t.id)}" type="button">${escapeHtml(t.label)}${resolveTabBadge(t, ctx)}</button>`,
    )
    .join("");
  return `${builtinHtml}${pluginHtml}`;
}

function renderKpiBar(model: ActionQueueModel, ctx: StudioRenderContext): string {
  return `<div class="flk-kpis">
    <button class="flk-kpi-btn active" data-tier-filter="all" type="button">
      <span class="flk-kpi-n">${model.items.length}</span>
      <div><div class="flk-kpi-lbl">All Action Items</div><div class="flk-kpi-sub">Click to filter</div></div>
    </button>
    <button class="flk-kpi-btn" data-tier-filter="broken" type="button">
      <span class="flk-kpi-n ${model.counts.broken > 0 ? "err" : "ok"}">${model.counts.broken}</span>
      <div><div class="flk-kpi-lbl">Broken</div><div class="flk-kpi-sub">Merge blockers</div></div>
    </button>
    <button class="flk-kpi-btn" data-tier-filter="fix_next" type="button">
      <span class="flk-kpi-n ${model.counts.fixNext > 0 ? "warn" : "ok"}">${model.counts.fixNext}</span>
      <div><div class="flk-kpi-lbl">Fix Next</div><div class="flk-kpi-sub">High-leverage guards</div></div>
    </button>
    <button class="flk-kpi-btn" data-tier-filter="structural" type="button">
      <span class="flk-kpi-n">${model.counts.structural}</span>
      <div><div class="flk-kpi-lbl">Structural</div><div class="flk-kpi-sub">Scattering & fences</div></div>
    </button>
    <div class="flk-kpi-btn" style="cursor:default">
      <span class="flk-kpi-n ok">${ctx.data.counts.features}</span>
      <div><div class="flk-kpi-lbl">Holding Strong</div><div class="flk-kpi-sub">${ctx.data.counts.tests} tests · ${ctx.data.counts.invariants} guards</div></div>
    </div>
  </div>`;
}

function renderGlossaryModal(): string {
  const cards = STUDIO_GLOSSARY.map(
    (g) =>
      `<div class="flk-guide-card"><div class="flk-guide-k">${escapeHtml(g.term)}</div><div class="flk-guide-v">${escapeHtml(g.plainEnglish)}</div><div class="flk-meta">${escapeHtml(g.whyItMatters)}</div><div><a class="flk-src-link" href="${escapeHtml(g.source.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(g.source.label)} ↗</a></div></div>`,
  ).join("");
  return `<div class="flk-modal-backdrop" id="flk-guide-modal" role="dialog" aria-label="FeatLock Plain-English Guide">
    <div class="flk-modal">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
        <strong style="font-size:20px">Plain-English Guide to FeatLock</strong>
        <button id="flk-guide-close" class="flk-btn" type="button">Close</button>
      </div>
      <div class="flk-meta">Every concept in this report explained without jargon, with links to the underlying research.</div>
      ${cards}
    </div>
  </div>`;
}

function renderFooterDisclosure(ctx: StudioRenderContext): string {
  const plugins = ctx.data.plugins
    .map((p) => `<div class="flk-item-row"><span class="flk-mono">${escapeHtml(p.id)} · ${escapeHtml(p.source)} · ${escapeHtml(p.status)}${p.guarded ? " (guarded)" : ""}</span></div>`)
    .join("");
  const audit = ctx.data.registry.auditLog
    .slice(-15)
    .toReversed()
    .map((a) => `<div class="flk-item-row"><span class="flk-mono">${escapeHtml(a.featureId)} [${escapeHtml(a.action)}]</span><span class="flk-meta">${escapeHtml(a.summary)}</span></div>`)
    .join("");
  return `<footer class="flk-footer">
    <details class="flk-details"><summary><span>Verification Details · ${ctx.data.plugins.length} Active Plugins · ${ctx.data.registry.auditLog.length} Audit Entries</span><span class="flk-meta">Expand raw metadata</span></summary>
      <div style="margin-top:8px"><strong>Active Plugins</strong>${plugins || '<div class="flk-meta">None</div>'}</div>
      ${audit ? `<div style="margin-top:12px"><strong>Recent Audit Trail</strong>${audit}</div>` : ""}
    </details>
  </footer>`;
}

function renderCustomTabPanels(ctx: StudioRenderContext): string {
  return ctx.tabs
    .map(
      (t) =>
        `<section class="flk-panel" data-tab-panel="${escapeHtml(t.id)}" data-plugin-tab="${escapeHtml(t.id)}"><div class="flk-wide">${t.renderHtml(ctx.data)}</div></section>`,
    )
    .join("\n");
}

function collectPluginScripts(ctx: StudioRenderContext): string {
  const scripts: string[] = [];
  for (const tab of ctx.tabs) {
    if (tab.clientScript && tab.clientScript.trim().length > 0) scripts.push(tab.clientScript);
  }
  for (const s of ctx.clientScripts) {
    if (s.trim().length > 0) scripts.push(s);
  }
  return scripts.map((code) => `<script>\n${code}\n</script>`).join("\n");
}

function renderBuiltinPanels(ctx: StudioRenderContext, model: ActionQueueModel): string {
  const widgetsHtml = renderCustomWidgetsHtml(ctx);
  return `<section class="flk-panel active" data-tab-panel="actions">
    ${renderKpiBar(model, ctx)}
    <div class="flk-split">
      <div class="flk-left" id="flk-action-list"></div>
      <div class="flk-right" id="flk-action-detail"></div>
    </div>
  </section>
  <section class="flk-panel" data-tab-panel="features">
    <div class="flk-split">
      <div class="flk-left">
        <input id="flk-feat-search" class="flk-input" type="search" placeholder="Filter apps & packages..." />
        <div id="flk-feat-groups"></div>
      </div>
      <div class="flk-right" id="flk-feat-detail"></div>
    </div>
  </section>
  <section class="flk-panel" data-tab-panel="map">
    <div class="flk-wide">
      <div class="flk-card">
        <h3>Protection & File-Scattering Map</h3>
        <div id="flk-map-svg"></div>
      </div>
      ${widgetsHtml}
    </div>
  </section>`;
}

export function renderDefaultStudioHtml(ctx: StudioRenderContext): string {
  if (!ctx || !ctx.data) throw new Error("StudioRenderContext with data is required.");
  const actionModel = buildActionModel(ctx.data);
  const pageTitle = ctx.title ?? `FeatLock Studio · ${ctx.data.repoName}`;
  const brand = ctx.brandLabel ?? "FeatLock Studio";
  const css = renderStudioCss(ctx.theme, ctx.css);
  const embeddedJson = serializeDataForScript({ ...ctx.data, actionModel, glossary: STUDIO_GLOSSARY });

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(pageTitle)}</title>
<style>${css}</style>
${ctx.headHtml.join("\n")}
</head>
<body>
<header class="flk-topbar">
  <div class="flk-bar-left">
    <div class="flk-brand"><span class="flk-brand-dot"></span><span>${escapeHtml(brand)}</span><span class="flk-badge">${escapeHtml(ctx.data.repoName)}</span></div>
    <nav class="flk-nav" role="tablist">${renderNavButtons(ctx, actionModel)}</nav>
  </div>
  <div class="flk-bar-right">
    <button id="flk-guide-open" class="flk-btn" type="button">? Guide</button>
    <button id="flk-theme-toggle" class="flk-btn" type="button">Light / Dark</button>
  </div>
</header>
<div class="flk-verdict">
  <span>${escapeHtml(actionModel.verdict)}</span>
  <span class="flk-meta flk-mono">${escapeHtml(ctx.data.generatedAt)}</span>
</div>
<main>
  ${renderBuiltinPanels(ctx, actionModel)}
  ${renderCustomTabPanels(ctx)}
</main>
${renderFooterDisclosure(ctx)}
${renderGlossaryModal()}
<script id="featlock-data" type="application/json">${embeddedJson}</script>
<script>${renderStudioClientScript()}</script>
${collectPluginScripts(ctx)}
</body>
</html>`;
}
