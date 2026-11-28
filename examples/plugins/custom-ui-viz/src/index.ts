import { Plugin, type FeatlockStudioData, type StudioRenderContext } from "@featlock/plugin";

interface AreaCoverageRow {
  readonly area: string;
  readonly features: number;
  readonly invariants: number;
  readonly strongFences: number;
  readonly pct: number;
}

function escapeText(raw: string): string {
  return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function computeAreaCoverage(data: FeatlockStudioData): AreaCoverageRow[] {
  const byArea = new Map<string, { features: number; invariants: number; strongFences: number }>();
  const featArea = new Map<string, string>();
  for (const f of data.registry.features) {
    if (f.status !== "active") continue;
    featArea.set(f.id, f.area);
    const cur = byArea.get(f.area) ?? { features: 0, invariants: 0, strongFences: 0 };
    cur.features += 1;
    byArea.set(f.area, cur);
  }
  for (const inv of data.registry.invariants) {
    if (inv.status !== "active") continue;
    const area = featArea.get(inv.featureId) ?? "unassigned";
    const cur = byArea.get(area) ?? { features: 0, invariants: 0, strongFences: 0 };
    cur.invariants += 1;
    if (inv.fenceRung === "R0" || inv.fenceRung === "R1" || inv.fenceRung === "R2") cur.strongFences += 1;
    byArea.set(area, cur);
  }
  return Array.from(byArea.entries())
    .map(([area, v]) => ({
      area,
      features: v.features,
      invariants: v.invariants,
      strongFences: v.strongFences,
      pct: v.invariants === 0 ? 100 : Math.round((v.strongFences / v.invariants) * 100),
    }))
    .toSorted((a, b) => a.area.localeCompare(b.area));
}

function renderHeatmapTab(data: FeatlockStudioData): string {
  const rows = (data.extensions["custom-ui-viz.areaCoverage"] as AreaCoverageRow[] | undefined) ?? computeAreaCoverage(data);
  const bars = rows
    .map((r, i) => {
      const y = 14 + i * 28;
      const w = Math.max(4, Math.round((r.pct / 100) * 280));
      const color = r.pct >= 80 ? "var(--ok)" : r.pct >= 40 ? "var(--warn)" : "var(--danger)";
      return `<text x="6" y="${y + 14}" fill="var(--muted)" font-size="12" font-family="var(--font-mono)">${escapeText(r.area.slice(0, 24))}</text>` +
        `<rect x="190" y="${y}" width="${w}" height="18" rx="4" fill="${color}" />` +
        `<text x="${198 + w}" y="${y + 14}" fill="var(--text)" font-size="12" font-family="var(--font-mono)">${r.pct}% (${r.strongFences}/${r.invariants})</text>`;
    })
    .join("");
  const height = Math.max(60, rows.length * 28 + 24);
  return `<div class="flk-card"><h3>Area Fence Strength Heatmap</h3><svg width="560" height="${height}">${bars}</svg></div>`;
}

function renderMinimalBoard(ctx: StudioRenderContext): string {
  const rows = (ctx.data.extensions["custom-ui-viz.areaCoverage"] as AreaCoverageRow[] | undefined) ?? computeAreaCoverage(ctx.data);
  const items = rows
    .map((r) => `<li><strong>${escapeText(r.area)}</strong>: ${r.features} features, ${r.invariants} invariants, ${r.pct}% static/test fenced</li>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"/><title>Custom Board · ${escapeText(ctx.data.repoName)}</title></head><body><main><h1>Custom FeatLock Board · ${escapeText(ctx.data.repoName)}</h1><ul>${items}</ul></main></body></html>`;
}

export default Plugin.define({
  id: "featlock.example.custom-ui-viz",
  async setup(ctx) {
    await ctx.studio.transform((ed) => {
      ed.addDataProvider({
        id: "custom-ui-viz.areaCoverage",
        provide: (data) => computeAreaCoverage(data),
      });
      ed.addWidget({
        id: "custom-ui-viz.summary",
        title: "Area Fence Coverage",
        order: 10,
        renderHtml: (data) => {
          const rows = (data.extensions["custom-ui-viz.areaCoverage"] as AreaCoverageRow[] | undefined) ?? [];
          const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.pct, 0) / rows.length) : 100;
          return `<div class="flk-kpi">${avg}%</div><div class="flk-meta">${rows.length} active area(s)</div>`;
        },
      });
      ed.addTab({
        id: "fence-heatmap",
        label: "Fence Heatmap",
        order: 20,
        badge: (data) => String(((data.extensions["custom-ui-viz.areaCoverage"] as AreaCoverageRow[] | undefined) ?? []).length),
        renderHtml: renderHeatmapTab,
      });
      ed.addRenderer({
        id: "custom-minimal-board",
        label: "Custom Minimal Board",
        description: "Example standalone custom UI renderer built via @featlock/plugin.",
        renderHtml: renderMinimalBoard,
        routes: [
          {
            path: "/api/custom-summary",
            handle: async (_req, getData) => {
              const data = await getData();
              return Response.json({
                repo: data.repoName,
                areas: data.extensions["custom-ui-viz.areaCoverage"] ?? [],
              });
            },
          },
        ],
      });
    });
  },
});
