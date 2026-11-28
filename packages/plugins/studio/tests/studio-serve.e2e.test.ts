import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";
import { startStudioServer } from "../src/index.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const CUSTOM_UI_PLUGIN = path.join(REPO_ROOT, "examples/plugins/custom-ui-viz");

describe("R7 Studio Golden-Path E2E", () => {
  let tmpDir = "";

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-r7-studio-e2e-"));
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "src", "checkout.ts"),
      'export function checkout(total: number) {\n  if (total < 0) throw new RangeError("negative total");\n  return total;\n}\n',
    );
    fs.writeFileSync(path.join(tmpDir, "tests", "checkout.test.ts"), 'test("checkout", () => {});\n');
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("extracts repo, mounts external custom-ui-viz plugin, renders HTML, and serves custom board + API", async () => {
    const host = await createPluginHost({
      repoDir: tmpDir,
      includeBuiltins: true,
      operations: [{ type: "add", target: CUSTOM_UI_PLUGIN }],
    });
    try {
      const ext = await host.extract(tmpDir);
      await host.writeRegistry(tmpDir, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });

      const outHtml = path.join(tmpDir, ".featlock", "studio.html");
      const code = await host.runCli(["ui", tmpDir, "--out", outHtml], tmpDir);
      expect(code).toBe(0);
      const written = fs.readFileSync(outHtml, "utf8");
      expect(written).toContain("FeatLock Studio");
      expect(written).toContain("Fence Heatmap");
      expect(written).toContain("Area Fence Coverage");

      const srv = startStudioServer({ host, repoRoot: tmpDir, port: 0, rendererId: "custom-minimal-board" });
      try {
        const signal = AbortSignal.timeout(5000);
        const [boardRes, summaryRes] = await Promise.all([
          fetch(`${srv.url}/`, { signal }),
          fetch(`${srv.url}/api/custom-summary`, { signal }),
        ]);
        expect(boardRes.status).toBe(200);
        expect(await boardRes.text()).toContain("Custom FeatLock Board");
        expect(summaryRes.status).toBe(200);
        const summary = (await summaryRes.json()) as { areas: Array<{ area: string }> };
        expect(summary.areas.length).toBeGreaterThanOrEqual(1);
      } finally {
        srv.stop();
      }
    } finally {
      await host.dispose();
    }
  });
});
