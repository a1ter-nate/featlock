import { describe, expect, test } from "bun:test";
import type { FeatlockStudioData, StudioRenderContext } from "@featlock/plugin";
import { buildActionModel, STUDIO_GLOSSARY } from "../packages/plugins/studio/src/guidance.ts";
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
    expect(html).toContain("Action Queue");
    expect(html).toContain("? Guide");
    expect(html).toContain("Plain-English Guide to FeatLock");
    expect(html).toContain("window.__t1=1;");
    expect(html).toContain("window.__extra=2;");
  });

  test("buildActionModel produces 4-part plain-English guidance, research links, and CLI commands across tiers", () => {
    const base = sampleData();
    const data: FeatlockStudioData = {
      ...base,
      registry: {
        ...base.registry,
        features: [
          ...base.registry.features,
          {
            id: "feat.unguarded",
            area: "app:web",
            name: "Web",
            summary: "Web dashboard",
            acceptanceCriteria: "Tests pass",
            status: "active",
            source: "ast",
          },
        ],
        invariants: [
          ...base.registry.invariants,
          {
            id: "inv:pay:bugfix",
            featureId: "feat.pay",
            kind: "precondition",
            statement: "Precondition fail-closed guard: amount > 0",
            file: "src/pay.ts",
            line: 12,
            confidence: 0.9,
            source: "ast",
            fenceRung: "runtime",
            originKind: "bugfix",
            enclosingSymbol: "charge",
            status: "active",
          },
        ],
      },
      check: {
        ...base.check,
        violations: [
          {
            id: "v:1",
            rule: "invariant-anchor-missing",
            severity: "error",
            featureId: "feat.pay",
            file: "src/pay.ts",
            message: "Guard missing",
            fix: "Restore guard",
          },
        ],
        warnings: [
          {
            id: "w:1",
            rule: "registry-empty",
            severity: "warn",
            message: "No committed registry yet",
            fix: "Run featlock extract . --write",
          },
        ],
      },
      matrix: {
        scattering: {
          ...base.matrix.scattering,
          highScattering: [{ featureId: "feat.pay", files: 12 }],
        },
        interactions: [
          {
            featureA: "feat.pay",
            featureB: "feat.unguarded",
            sharedVia: ["src/shared.ts"],
            sharedTests: [],
            pairwiseGap: true,
          },
        ],
        flags: [{ flag: "ENABLE_NEW_PAY", file: "src/pay.ts", line: 4, status: "unlinked" }],
      },
    };

    const model = buildActionModel(data);
    expect(model.isLivePreview).toBe(true);
    expect(model.counts.broken).toBe(1);
    expect(model.counts.fixNext).toBe(5);
    expect(model.counts.structural).toBe(2);
    expect(model.counts.holding).toBe(2);
    expect(model.verdict).toContain("1 blocking issue");
    for (const item of model.items) {
      expect(item.what.length).toBeGreaterThan(10);
      expect(item.why.length).toBeGreaterThan(10);
      expect(item.fix.length).toBeGreaterThan(10);
      expect(item.benefit.length).toBeGreaterThan(10);
      expect(item.cliCommand.length).toBeGreaterThan(5);
      expect(item.sources.length).toBeGreaterThan(0);
      expect(item.sources[0]?.url.startsWith("https://")).toBe(true);
    }
    expect(STUDIO_GLOSSARY.length).toBeGreaterThanOrEqual(5);
  });
});
