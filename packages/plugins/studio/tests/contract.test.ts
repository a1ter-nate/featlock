import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import type { FeatlockStudioData, StudioRenderContext } from "@featlock/plugin";
import { renderDefaultStudioHtml } from "../src/render.ts";

function makeStudioData(repoName: string, featureCount: number): FeatlockStudioData {
  const features = Array.from({ length: featureCount }, (_, i) => ({
    id: `feat.mod.${i}`,
    area: "mod",
    name: `Feature ${i}`,
    summary: `Summary ${i}`,
    acceptanceCriteria: "Passes",
    status: "active" as const,
    source: "ast",
  }));
  return {
    schemaVersion: 1,
    repoName,
    repoRoot: `/tmp/${repoName}`,
    generatedAt: "2026-11-27T00:00:00.000Z",
    counts: { features: featureCount, tests: 0, invariants: 0, auditEntries: 0 },
    registry: { features, tests: [], invariants: [], auditLog: [] },
    check: { ok: true, violations: [], warnings: [], counts: { features: featureCount, tests: 0, invariants: 0, auditEntries: 0 } },
    matrix: { scattering: { dosByFeature: {}, dofByFile: {}, highScattering: [], highTangling: [] }, interactions: [], flags: [] },
    concernSubgraphs: {},
    fenceDistribution: { R0: 0, R1: 0, R2: 0, R3: 0, runtime: 0, none: 0, bugfixOrigin: 0, superseded: 0 },
    plugins: [],
    extensions: {},
  };
}

class RenderTabCmd implements fc.AsyncCommand<{ tabs: string[] }, { tabId: string }> {
  constructor(readonly tabId: string, readonly repoName: string, readonly count: number) {}
  check(): boolean { return true; }
  async run(model: { tabs: string[] }): Promise<void> {
    if (!model.tabs.includes(this.tabId)) model.tabs.push(this.tabId);
    const ctx: StudioRenderContext = {
      data: makeStudioData(this.repoName, this.count),
      tabs: model.tabs.map((id) => ({ id, label: `Tab ${id}`, renderHtml: () => `<p>${id}</p>` })),
      widgets: [],
      theme: {},
      css: [],
      headHtml: [],
      clientScripts: [],
      inline: false,
    };
    const html = renderDefaultStudioHtml(ctx);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain(`data-plugin-tab="${this.tabId}"`);
    expect(html).not.toContain("</script><script>alert");
  }
}

describe("@featlock/plugin-studio MBT & OpenAPI contract", () => {
  test("OpenAPI 3.1 Studio API contract declares all core endpoints", () => {
    const spec = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, "../openapi.json"), "utf8")) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(["/", "/api/health", "/api/plugins", "/api/data"]);
  });

  test("renderDefaultStudioHtml safely renders arbitrary tab compositions and escapes embedded JSON", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.commands(
          [
            fc
              .tuple(
                fc.stringMatching(/^[a-z][a-z0-9-]{1,10}$/),
                fc.stringMatching(/^[a-z0-9_-]{1,12}$/),
                fc.integer({ min: 0, max: 5 }),
              )
              .map(([tabId, repoName, count]) => new RenderTabCmd(tabId, repoName, count)),
          ],
          { maxCommands: 6 },
        ),
        async (cmds) => {
          await fc.asyncModelRun(() => ({ model: { tabs: [] }, real: { tabId: "" } }), cmds);
        },
      ),
      { numRuns: 10 },
    );
  });
});
