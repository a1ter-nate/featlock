import type { StudioRenderContext, StudioTabSpec } from "@featlock/plugin";
import { renderStudioClientScript } from "./client.ts";
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
  return `<section class="flk-grid" style="margin-top:16px" data-plugin-widgets="true">${cards}</section>`;
}

function renderNavButtons(ctx: StudioRenderContext): string {
  const c = ctx.data.counts;
  const builtinTabs: Array<{ id: string; label: string; badge?: string }> = [
    { id: "overview", label: "Overview" },
    { id: "features", label: "Features & Tests", badge: String(c.features) },
    { id: "invariants", label: "Invariants & Fences", badge: String(c.invariants) },
    { id: "matrix", label: "Matrix & Flags" },
    { id: "graph", label: "Feature Graph" },
    { id: "audit", label: "Check & Audit", badge: String(ctx.data.check.violations.length + ctx.data.check.warnings.length) },
  ];
  const builtinHtml = builtinTabs
    .map(
      (t) =>
        `<button class="flk-tab-btn" data-tab-btn="${escapeHtml(t.id)}">${escapeHtml(t.label)}${t.badge ? `<span class="flk-badge">${escapeHtml(t.badge)}</span>` : ""}</button>`,
    )
    .join("");
  const pluginHtml = ctx.tabs
    .map(
      (t) =>
        `<button class="flk-tab-btn" data-tab-btn="${escapeHtml(t.id)}">${escapeHtml(t.label)}${resolveTabBadge(t, ctx)}</button>`,
    )
    .join("");
  return `${builtinHtml}${pluginHtml}`;
}

function renderCustomTabPanels(ctx: StudioRenderContext): string {
  return ctx.tabs
    .map(
      (t) =>
        `<section class="flk-panel" data-tab-panel="${escapeHtml(t.id)}" data-plugin-tab="${escapeHtml(t.id)}">${t.renderHtml(ctx.data)}</section>`,
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

export function renderDefaultStudioHtml(ctx: StudioRenderContext): string {
  if (!ctx || !ctx.data) throw new Error("StudioRenderContext with data is required.");
  const pageTitle = ctx.title ?? `FeatLock Studio · ${ctx.data.repoName}`;
  const brand = ctx.brandLabel ?? "FeatLock Studio";
  const css = renderStudioCss(ctx.theme, ctx.css);
  const headExtra = ctx.headHtml.join("\n");
  const embeddedJson = serializeDataForScript(ctx.data);
  const pluginScripts = collectPluginScripts(ctx);

  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(pageTitle)}</title>
<style>${css}</style>
${headExtra}
</head>
<body>
<div class="flk-shell">
  <header class="flk-header">
    <div class="flk-brand">
      <h1>${escapeHtml(brand)}</h1>
      <span class="flk-meta">${escapeHtml(ctx.data.repoName)} · ${escapeHtml(ctx.data.generatedAt)}</span>
    </div>
    <button id="flk-theme-toggle" class="flk-btn" type="button">Toggle theme</button>
  </header>
  <nav class="flk-nav" role="tablist">${renderNavButtons(ctx)}</nav>
  <main>
    <section class="flk-panel active" data-tab-panel="overview">
      <div id="panel-overview-core"></div>
      ${renderCustomWidgetsHtml(ctx)}
    </section>
    <section class="flk-panel" data-tab-panel="features">
      <div class="flk-controls"><input id="flk-feat-search" class="flk-input" type="search" placeholder="Filter features..." /></div>
      <div class="flk-card"><table class="flk-table"><thead><tr><th>ID</th><th>Feature</th><th>Area</th><th>Status</th><th>Tests</th></tr></thead><tbody id="features-tbody"></tbody></table></div>
    </section>
    <section class="flk-panel" data-tab-panel="invariants">
      <div class="flk-controls">
        <input id="flk-inv-search" class="flk-input" type="search" placeholder="Filter invariants..." />
        <select id="flk-inv-rung" class="flk-select"><option value="all">All fences</option><option value="R0">R0</option><option value="R1">R1</option><option value="R2">R2</option><option value="R3">R3</option><option value="runtime">runtime</option><option value="none">none</option></select>
      </div>
      <div class="flk-card"><table class="flk-table"><thead><tr><th>ID</th><th>Fence</th><th>Statement</th><th>Location</th><th>Source</th></tr></thead><tbody id="invariants-tbody"></tbody></table></div>
    </section>
    <section class="flk-panel" data-tab-panel="matrix" id="panel-matrix"></section>
    <section class="flk-panel" data-tab-panel="graph" id="panel-graph"></section>
    <section class="flk-panel" data-tab-panel="audit" id="panel-audit"></section>
    ${renderCustomTabPanels(ctx)}
  </main>
</div>
<script id="featlock-data" type="application/json">${embeddedJson}</script>
<script>${renderStudioClientScript()}</script>
${pluginScripts}
</body>
</html>`;
}
