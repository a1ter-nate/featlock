import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";
import { Plugin } from "@featlock/plugin";
import studioPlugin, { startStudioServer } from "../src/index.ts";

describe("@featlock/plugin-studio unit contract", () => {
  test("registers default renderer, ui/studio CLI commands, and serves live JSON/HTML + custom routes", async () => {
    expect(studioPlugin.id).toBe("featlock.studio");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-studio-unit-"));
    try {
      fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, "src", "billing.ts"),
        'export function charge(cents: number) {\n  if (cents <= 0) throw new RangeError("positive cents required");\n  return cents;\n}\n',
      );
      fs.writeFileSync(path.join(tmp, "tests", "billing.test.ts"), 'test("charge", () => {});\n');

      const customRoutePlugin = Plugin.define({
        id: "test.studio.custom-route",
        async setup(ctx) {
          await ctx.studio.transform((ed) => {
            ed.addDataProvider({
              id: "riskScore",
              provide: (data) => ({ totalFeatures: data.counts.features }),
            });
            ed.addWidget({
              id: "risk-card",
              title: "Risk Score",
              renderHtml: (data) => `<div class="flk-kpi">${String((data.extensions.riskScore as { totalFeatures: number }).totalFeatures)}</div>`,
            });
            ed.addTab({
              id: "custom-board",
              label: "Custom Board",
              renderHtml: (data) => `<section>Board for ${data.repoName}</section>`,
            });
            ed.addRenderer({
              id: "custom-alt-ui",
              label: "Alt UI",
              renderHtml: (rctx) => `<!doctype html><html><body><h1>Alt ${rctx.data.repoName}</h1></body></html>`,
              routes: [
                {
                  path: "/api/custom-ping",
                  handle: async (_req, getData) => {
                    const data = await getData();
                    return Response.json({ ping: true, features: data.counts.features });
                  },
                },
              ],
            });
          });
        },
      });

      const host = await createPluginHost({ repoDir: tmp, includeBuiltins: true, plugins: [customRoutePlugin] });
      try {
        const ext = await host.extract(tmp);
        await host.writeRegistry(tmp, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });

        const cmdIds = host.getCommands().map((c) => c.id);
        expect(cmdIds).toContain("ui");
        expect(cmdIds).toContain("studio");

        const html = await host.renderStudio(tmp);
        expect(html).toContain("FeatLock Studio");
        expect(html).toContain("Risk Score");
        expect(html).toContain("Custom Board");
        expect(html).toContain("featlock-data");

        const altHtml = await host.renderStudio(tmp, { rendererId: "custom-alt-ui" });
        expect(altHtml).toContain(`<h1>Alt ${path.basename(tmp)}</h1>`);

        const srv = startStudioServer({ host, repoRoot: tmp, port: 0, rendererId: "custom-alt-ui" });
        try {
          const [homeRes, dataRes, pingRes] = await Promise.all([
            fetch(`${srv.url}/`),
            fetch(`${srv.url}/api/data`),
            fetch(`${srv.url}/api/custom-ping`),
          ]);
          expect(homeRes.status).toBe(200);
          expect(await homeRes.text()).toContain("<h1>Alt ");
          expect(dataRes.status).toBe(200);
          const payload = (await dataRes.json()) as { counts: { features: number }; extensions: { riskScore: { totalFeatures: number } } };
          expect(payload.counts.features).toBeGreaterThanOrEqual(1);
          expect(payload.extensions.riskScore.totalFeatures).toBe(payload.counts.features);
          expect(pingRes.status).toBe(200);
          expect((await pingRes.json() as { ping: boolean }).ping).toBe(true);
        } finally {
          srv.stop();
        }
      } finally {
        await host.dispose();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
