import type { StudioThemeTokens } from "@featlock/plugin";

const BASE_THEME_CSS = `
:root {
  --bg: #07090e;
  --surface: #0c0f17;
  --panel: #11151f;
  --panel-hi: #171c28;
  --border: rgba(255, 255, 255, 0.10);
  --border-hi: rgba(255, 255, 255, 0.18);
  --text: #e8ecf4;
  --text-2: #b0b9cb;
  --muted: #8590a6;
  --accent: #7cc8ff;
  --accent-soft: rgba(124, 200, 255, 0.13);
  --ok: #5fd9a0;
  --ok-soft: rgba(95, 217, 160, 0.12);
  --warn: #f5c26b;
  --warn-soft: rgba(245, 194, 107, 0.13);
  --danger: #ff8a8a;
  --danger-soft: rgba(255, 138, 138, 0.14);
  --fs-11: 13px;
  --fs-12: 14px;
  --fs-13: 15px;
  --fs-15: 18px;
  --fs-20: 24px;
  --h-bar: 54px;
  --h-ctl: 36px;
  --r-2: 6px;
  --r-3: 10px;
  --font-sans: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
[data-theme="light"] {
  --bg: #f4f6fa;
  --surface: #ffffff;
  --panel: #eef2f8;
  --panel-hi: #e4ebf5;
  --border: rgba(15, 23, 42, 0.12);
  --border-hi: rgba(15, 23, 42, 0.22);
  --text: #0f172a;
  --text-2: #334155;
  --muted: #526075;
  --accent: #2563eb;
  --accent-soft: rgba(37, 99, 235, 0.10);
  --ok: #059669;
  --ok-soft: rgba(5, 150, 105, 0.10);
  --warn: #d97706;
  --warn-soft: rgba(217, 119, 6, 0.12);
  --danger: #dc2626;
  --danger-soft: rgba(220, 38, 38, 0.10);
}
*, *::before, *::after { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0; background: var(--bg); color: var(--text);
  font-family: var(--font-sans); font-size: 16px; line-height: 1.55;
}`;

const SHELL_AND_QUEUE_CSS = `
.flk-topbar {
  position: sticky; top: 0; z-index: 30;
  display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
  min-height: var(--h-bar); padding: 0 22px;
  background: var(--surface); border-bottom: 1px solid var(--border);
}
.flk-bar-left { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.flk-brand { display: flex; align-items: center; gap: 10px; font-size: var(--fs-15); font-weight: 700; color: var(--text); }
.flk-brand-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
.flk-nav { display: flex; align-items: stretch; gap: 4px; }
.flk-tab-btn {
  background: transparent; border: 0; border-bottom: 2px solid transparent;
  color: var(--muted); padding: 14px 14px; font: inherit; font-size: var(--fs-13); font-weight: 500;
  cursor: pointer; display: inline-flex; align-items: center; gap: 7px; white-space: nowrap;
}
.flk-tab-btn:hover { color: var(--text); }
.flk-tab-btn.active { color: var(--text); font-weight: 600; border-bottom-color: var(--accent); }
.flk-badge {
  padding: 2px 7px; border-radius: 999px; font-size: 12px; font-family: var(--font-mono);
  background: var(--panel); color: var(--text-2); border: 1px solid var(--border);
}
.flk-bar-right { display: flex; align-items: center; gap: 8px; }
.flk-btn, .flk-input, .flk-select {
  height: var(--h-ctl); background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-2); padding: 0 12px;
  font: inherit; font-size: var(--fs-12);
}
.flk-btn { cursor: pointer; font-weight: 500; }
.flk-btn:hover { border-color: var(--accent); background: var(--panel-hi); }
.flk-verdict {
  padding: 12px 22px; background: var(--panel); border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
  font-size: var(--fs-13); color: var(--text);
}
.flk-kpis { display: flex; gap: 10px; padding: 14px 22px; flex-wrap: wrap; border-bottom: 1px solid var(--border); background: var(--bg); }
.flk-kpi-btn {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3);
  padding: 11px 16px; display: inline-flex; align-items: center; gap: 12px;
  cursor: pointer; color: var(--text-2); text-align: left;
}
.flk-kpi-btn:hover { border-color: var(--border-hi); background: var(--panel); }
.flk-kpi-btn.active { border-color: var(--accent); background: var(--panel-hi); color: var(--text); }
.flk-kpi-n { font-size: var(--fs-20); font-weight: 700; font-family: var(--font-mono); line-height: 1; color: var(--text); }
.flk-kpi-n.err { color: var(--danger); }
.flk-kpi-n.warn { color: var(--warn); }
.flk-kpi-n.ok { color: var(--ok); }
.flk-kpi-lbl { font-size: var(--fs-11); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.flk-kpi-sub { font-size: 12px; color: var(--muted); font-family: var(--font-mono); }`;

const DETAIL_AND_COMPONENTS_CSS = `
.flk-panel { display: none; }
.flk-panel.active { display: block; }
.flk-split { display: grid; grid-template-columns: minmax(340px, 460px) minmax(0, 1fr); min-height: 540px; }
@media (max-width: 980px) { .flk-split { grid-template-columns: 1fr; } }
.flk-left { border-right: 1px solid var(--border); padding: 16px 18px; display: flex; flex-direction: column; gap: 14px; background: var(--bg); }
.flk-right { padding: 24px 28px 36px; background: var(--surface); display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.flk-tier-h { font-size: var(--fs-11); font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.flk-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.flk-dot.err { background: var(--danger); }
.flk-dot.warn { background: var(--warn); }
.flk-dot.info { background: var(--accent); }
.flk-dot.ok { background: var(--ok); }
.flk-tile {
  width: 100%; text-align: left; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--r-3); padding: 14px 16px; cursor: pointer; color: var(--text);
  display: flex; flex-direction: column; gap: 5px; margin-bottom: 8px;
}
.flk-tile:hover { border-color: var(--border-hi); background: var(--panel); }
.flk-tile.active { border-color: var(--accent); background: var(--panel-hi); box-shadow: inset 3px 0 0 var(--accent); }
.flk-tile-top { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; }
.flk-tile-title { font-size: var(--fs-13); font-weight: 600; color: var(--text); }
.flk-tile-cnt { font-family: var(--font-mono); font-size: var(--fs-15); font-weight: 700; color: var(--text); }
.flk-tile-sub { font-size: var(--fs-11); color: var(--muted); }
.flk-guide-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 820px) { .flk-guide-grid { grid-template-columns: 1fr; } }
.flk-guide-card {
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-3);
  padding: 15px 17px; display: flex; flex-direction: column; gap: 6px;
}
.flk-guide-card.is-good { border-color: rgba(95, 217, 160, 0.35); background: var(--ok-soft); }
.flk-guide-k { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.flk-guide-card.is-good .flk-guide-k { color: var(--ok); }
.flk-guide-v { font-size: var(--fs-13); color: var(--text); line-height: 1.55; max-width: 72ch; }
.flk-cmd-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-2); padding: 10px 14px;
}
.flk-mono { font-family: var(--font-mono); font-size: var(--fs-12); }
.flk-meta { color: var(--muted); font-size: var(--fs-11); }
.flk-sources { display: flex; flex-wrap: wrap; gap: 8px; }
.flk-src-link {
  display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-12); color: var(--accent);
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-2);
  padding: 6px 12px; text-decoration: none;
}
.flk-src-link:hover { border-color: var(--accent); background: var(--panel); }
.flk-details { border: 1px solid var(--border); border-radius: var(--r-2); background: var(--bg); padding: 10px 14px; margin-bottom: 8px; }
.flk-details summary { cursor: pointer; font-weight: 600; font-size: var(--fs-13); color: var(--text); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.flk-item-row { padding: 8px 0; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 3px; }
.flk-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-family: var(--font-mono); border: 1px solid var(--border); background: var(--panel); color: var(--text-2); }
.flk-pill.ok { color: var(--ok); border-color: var(--ok); }
.flk-pill.warn { color: var(--warn); border-color: var(--warn); }
.flk-pill.danger { color: var(--danger); border-color: var(--danger); }
.flk-wide { max-width: 1280px; margin: 0 auto; padding: 20px 24px 40px; display: flex; flex-direction: column; gap: 16px; }
.flk-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-3); padding: 16px 18px; }
.flk-card h3 { margin: 0 0 10px; font-size: var(--fs-12); text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
.flk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.flk-footer { border-top: 1px solid var(--border); padding: 14px 22px; background: var(--surface); }
.flk-modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.72); z-index: 80; display: none; align-items: center; justify-content: center; padding: 20px; }
.flk-modal-backdrop.open { display: flex; }
.flk-modal { background: var(--surface); border: 1px solid var(--border-hi); border-radius: var(--r-3); max-width: 760px; width: 100%; max-height: 680px; overflow-y: auto; padding: 22px 24px; display: flex; flex-direction: column; gap: 14px; }`;

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
  const parts = [BASE_THEME_CSS, SHELL_AND_QUEUE_CSS, DETAIL_AND_COMPONENTS_CSS, buildThemeOverrideCss(theme), ...extraCss];
  return parts.filter((p) => p.trim().length > 0).join("\n");
}
