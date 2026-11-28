import type { StudioThemeTokens } from "@featlock/plugin";

const BASE_THEME_CSS = `
:root {
  --bg: #0c0e12;
  --surface: #131720;
  --panel: #191f2c;
  --border: #273043;
  --text: #e6ecf5;
  --muted: #8b98b0;
  --accent: #5ea0ff;
  --ok: #34d399;
  --warn: #f59e0b;
  --danger: #f87171;
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
[data-theme="light"] {
  --bg: #f6f8fb;
  --surface: #ffffff;
  --panel: #f0f4fa;
  --border: #d5deeb;
  --text: #111827;
  --muted: #526075;
  --accent: #2563eb;
  --ok: #059669;
  --warn: #d97706;
  --danger: #dc2626;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.5;
}`;

const LAYOUT_CSS = `
.flk-shell { max-width: 1360px; margin: 0 auto; padding: 20px 24px 48px; }
.flk-header {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 12px; padding-bottom: 16px; border-bottom: 1px solid var(--border);
}
.flk-brand { display: flex; align-items: baseline; gap: 10px; }
.flk-brand h1 { margin: 0; font-size: 20px; letter-spacing: -0.02em; }
.flk-meta { color: var(--muted); font-size: 12px; font-family: var(--font-mono); }
.flk-nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 20px; border-bottom: 1px solid var(--border); padding-bottom: 10px; }
.flk-tab-btn {
  background: transparent; color: var(--muted); border: 1px solid transparent;
  padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; font-weight: 500;
}
.flk-tab-btn:hover { color: var(--text); background: var(--panel); }
.flk-tab-btn.active { color: var(--text); background: var(--panel); border-color: var(--border); }
.flk-badge {
  display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px;
  font-size: 11px; font-family: var(--font-mono); background: var(--surface); color: var(--muted);
}
.flk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 20px; }
.flk-card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px;
}
.flk-card h3 { margin: 0 0 8px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.flk-kpi { font-size: 28px; font-weight: 700; font-family: var(--font-mono); letter-spacing: -0.02em; }`;

const COMPONENT_CSS = `
.flk-ok { color: var(--ok); }
.flk-warn { color: var(--warn); }
.flk-danger { color: var(--danger); }
.flk-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
.flk-input, .flk-select, .flk-btn {
  background: var(--surface); color: var(--text); border: 1px solid var(--border);
  border-radius: 6px; padding: 6px 10px; font: inherit;
}
.flk-btn { cursor: pointer; }
.flk-btn:hover { border-color: var(--accent); }
.flk-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.flk-table th, .flk-table td {
  text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top;
}
.flk-table th { color: var(--muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
.flk-mono { font-family: var(--font-mono); font-size: 12px; }
.flk-pill {
  display: inline-block; padding: 2px 7px; border-radius: 999px; font-size: 11px;
  font-family: var(--font-mono); border: 1px solid var(--border); background: var(--panel);
}
.flk-pill.ok { color: var(--ok); border-color: var(--ok); }
.flk-pill.warn { color: var(--warn); border-color: var(--warn); }
.flk-pill.danger { color: var(--danger); border-color: var(--danger); }
.flk-split { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(360px, 2fr); gap: 16px; }
@media (max-width: 860px) { .flk-split { grid-template-columns: 1fr; } }
.flk-svg-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px; overflow-x: auto; }
.flk-list-item {
  width: 100%; text-align: left; background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer;
}
.flk-list-item.active { border-color: var(--accent); background: var(--panel); }
.flk-panel { display: none; }
.flk-panel.active { display: block; }`;

export function buildThemeOverrideCss(theme: StudioThemeTokens): string {
  const vars: string[] = [];
  if (theme.bg) vars.push(`--bg:${theme.bg};`);
  if (theme.surface) vars.push(`--surface:${theme.surface};`);
  if (theme.panel) vars.push(`--panel:${theme.panel};`);
  if (theme.border) vars.push(`--border:${theme.border};`);
  if (theme.text) vars.push(`--text:${theme.text};`);
  if (theme.muted) vars.push(`--muted:${theme.muted};`);
  if (theme.accent) vars.push(`--accent:${theme.accent};`);
  if (theme.ok) vars.push(`--ok:${theme.ok};`);
  if (theme.warn) vars.push(`--warn:${theme.warn};`);
  if (theme.danger) vars.push(`--danger:${theme.danger};`);
  if (theme.fontSans) vars.push(`--font-sans:${theme.fontSans};`);
  if (theme.fontMono) vars.push(`--font-mono:${theme.fontMono};`);
  return vars.length > 0 ? `:root{${vars.join("")}}` : "";
}

export function renderStudioCss(theme: StudioThemeTokens, extraCss: readonly string[]): string {
  const parts = [BASE_THEME_CSS, LAYOUT_CSS, COMPONENT_CSS, buildThemeOverrideCss(theme), ...extraCss];
  return parts.filter((p) => p.trim().length > 0).join("\n");
}
