import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";
import { Plugin } from "@featlock/plugin";
import { startStudioServer } from "../src/index.ts";

function seededNext(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("R4 Studio Loopback HTTP, Real SQLite & Deterministic Fault Simulation", () => {
  let tmpDir = "";

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-r4-studio-"));
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "ledger.ts"),
      'export function postEntry(amount: number) {\n  if (amount === 0) throw new Error("zero entry rejected");\n  return amount;\n}\n',
    );
    fs.writeFileSync(path.join(tmpDir, "tests", "ledger.test.ts"), 'test("postEntry", () => {});\n');
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("serves real SQLite-backed Studio HTML, JSON API, refresh, and custom plugin routes over loopback HTTP", async () => {
    const customUi = Plugin.define({
      id: "r4.studio.route",
      async setup(ctx) {
        await ctx.studio.transform((ed) => {
          ed.addRenderer({
            id: "r4-custom-ui",
            label: "R4 Custom UI",
            renderHtml: (rctx) => `<!doctype html><html><body><h1>R4:${rctx.data.counts.features}</h1></body></html>`,
            routes: [
              {
                path: "/api/r4-check",
                handle: async (_req, getData) => {
                  const data = await getData();
                  return Response.json({ ok: true, invariants: data.counts.invariants });
                },
              },
            ],
          });
        });
      },
    });

    const host = await createPluginHost({ repoDir: tmpDir, includeBuiltins: true, plugins: [customUi] });
    try {
      const ext = await host.extract(tmpDir);
      await host.writeRegistry(tmpDir, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });
      const db = new Database(path.join(tmpDir, ".featlock", "registry.sqlite"), { readonly: true });
      try {
        const row = db.query("SELECT COUNT(*) as c FROM features").get() as { c: number };
        expect(row.c).toBe(1);
      } finally {
        db.close();
      }

      const srv = startStudioServer({ host, repoRoot: tmpDir, port: 0, rendererId: "r4-custom-ui" });
      try {
        const signal = AbortSignal.timeout(5000);
        const [home, apiData, health, plugins, custom, missing] = await Promise.all([
          fetch(`${srv.url}/`, { signal }),
          fetch(`${srv.url}/api/data?refresh=1`, { signal }),
          fetch(`${srv.url}/api/health`, { signal }),
          fetch(`${srv.url}/api/plugins`, { signal }),
          fetch(`${srv.url}/api/r4-check`, { signal }),
          fetch(`${srv.url}/nonexistent`, { signal }),
        ]);
        expect(home.status).toBe(200);
        expect(await home.text()).toContain("<h1>R4:1</h1>");
        expect(apiData.status).toBe(200);
        const payload = (await apiData.json()) as { counts: { features: number } };
        expect(payload.counts.features).toBe(1);
        expect(health.status).toBe(200);
        expect(plugins.status).toBe(200);
        expect(custom.status).toBe(200);
        expect((await custom.json() as { ok: boolean }).ok).toBe(true);
        expect(missing.status).toBe(404);
      } finally {
        srv.stop();
      }
    } finally {
      await host.dispose();
    }
  });

  test("seeded deterministic fault injection keeps healthy Studio routes resilient", async () => {
    const rng = seededNext(42_007);
    const faultSchedule = Array.from({ length: 6 }, () => rng() < 0.5);
    let idx = 0;
    const flakyPlugin = Plugin.define({
      id: "r4.dst.fault-injection",
      async setup(ctx) {
        await ctx.studio.transform((ed) => {
          ed.addRenderer({
            id: "r4-dst-ui",
            renderHtml: (rctx) => `<!doctype html><html><body>${rctx.data.repoName}</body></html>`,
            routes: [
              {
                path: "/api/dst-probe",
                handle: () => {
                  const shouldFault = faultSchedule[idx % faultSchedule.length];
                  idx += 1;
                  return shouldFault
                    ? new Response("injected-fault", { status: 503 })
                    : Response.json({ ok: true, step: idx });
                },
              },
            ],
          });
        });
      },
    });
    const host = await createPluginHost({ repoDir: tmpDir, includeBuiltins: true, plugins: [flakyPlugin] });
    try {
      const srv = startStudioServer({ host, repoRoot: tmpDir, port: 0, rendererId: "r4-dst-ui" });
      try {
        const signal = AbortSignal.timeout(5000);
        const statuses: number[] = [];
        for (let i = 0; i < faultSchedule.length; i += 1) {
          const res = await fetch(`${srv.url}/api/dst-probe`, { signal });
          statuses.push(res.status);
        }
        expect(statuses).toEqual(faultSchedule.map((f) => (f ? 503 : 200)));
        const health = await fetch(`${srv.url}/api/health`, { signal });
        expect(health.status).toBe(200);
      } finally {
        srv.stop();
      }
    } finally {
      await host.dispose();
    }
  });
});
