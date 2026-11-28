import { describe, expect, test } from "bun:test";
import type { FeatlockStudioData, StudioRenderContext } from "@featlock/plugin";
import { escapeHtml, renderDefaultStudioHtml } from "../packages/plugins/studio/src/render.ts";
import { buildThemeOverrideCss, renderStudioCss } from "../packages/plugins/studio/src/styles.ts";

function sampleData(): FeatlockStudioData {
  return {
    schemaVersion: 1,
    repoName: "sample-repo",
    repoRoot: "/tmp/sample-repo",
    generatedAt: "2026-11-27T00:00:00.000Z",
    counts: { features: 1, tests: 1, invariants: 1, auditEntries: 0 },
    registry: {
      features: [
        {
          id: "feat.pay",
          area: "pay",
          name: "Payments",
          summary: "Processes payments",
          acceptanceCriteria: "Tests pass",
          status: "active",
          source: "ast",
        },
      ],
      tests: [{ featureId: "feat.pay", testPath: "tests/pay.test.ts", testPattern: "pay", rung: "R2" }],
      invariants: [
        {
          id: "inv:pay:1",
          featureId: "feat.pay",
          kind: "precondition",
          statement: "Amount > 0",
          file: "src/pay.ts",
          line: 2,
          confidence: 0.9,
          source: "ast",
          fenceRung: "R1",
          status: "active",
        },
      ],
      auditLog: [],
    },
    check: { ok: true, violations: [], warnings: [], counts: { features: 1, tests: 1, invariants: 1, auditEntries: 0 } },
    matrix: { scattering: { dosByFeature: { "feat.pay": 1 }, dofByFile: {}, highScattering: [], highTangling: [] }, interactions: [], flags: [] },
    concernSubgraphs: {},
    fenceDistribution: { R0: 0, R1: 1, R2: 0, R3: 0, runtime: 0, none: 0, bugfixOrigin: 0, superseded: 0 },
    plugins: [],
    extensions: {},
  };
}

describe("@featlock/plugin-studio pure rendering unit tests", () => {
  test("escapeHtml neutralizes HTML tags and quotes", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
  });

  test("buildThemeOverrideCss and renderStudioCss emit custom CSS variables cleanly", () => {
    const vars = buildThemeOverrideCss({ bg: "#000", accent: "#0ff", fontMono: "monospace" });
    expect(vars).toBe(":root{--bg:#000;--accent:#0ff;--font-mono:monospace;}");
    expect(buildThemeOverrideCss({})).toBe("");
    const full = renderStudioCss({ accent: "#0ff" }, [".extra{color:red}"]);
    expect(full).toContain("--accent:#0ff;");
    expect(full).toContain(".extra{color:red}");
  });

  test("renderDefaultStudioHtml composes widgets, tabs, and XSS-safe JSON", () => {
    const ctx: StudioRenderContext = {
      data: sampleData(),
      tabs: [{ id: "t1", label: "Tab One", badge: "9", renderHtml: () => "<p>body</p>", clientScript: "window.__t1=1;" }],
      widgets: [{ id: "w1", title: "Widget One", renderHtml: () => "<span>ok</span>" }],
      theme: { accent: "#123456" },
      css: [".w1{padding:4px}"],
      headHtml: ['<meta name="x-studio" content="1">'],
      clientScripts: ["window.__extra=2;"],
      title: "Custom Title",
      brandLabel: "Custom Brand",
      inline: false,
    };
    const html = renderDefaultStudioHtml(ctx);
    expect(html).toContain("<title>Custom Title</title>");
    expect(html).toContain("Custom Brand");
    expect(html).toContain("Widget One");
    expect(html).toContain("Tab One");
    expect(html).toContain("window.__t1=1;");
    expect(html).toContain("window.__extra=2;");
  });
});
