import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";

describe("Built-in Plugins: ast-scanner, repospec-bridge, veristack-bridge, harnesses, invariant-passes, registry-cli, config, anti-deletion-guard", () => {
  let tmpRepo = "";

  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-bridges-"));
    fs.mkdirSync(path.join(tmpRepo, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, "rules"), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, ".verification", "laws"), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, "package.json"), JSON.stringify({ name: "bridge-fixture" }));
    fs.writeFileSync(path.join(tmpRepo, "src", "index.ts"), 'export function check(x: number) { if (x < 0) throw new Error("neg"); return x; }\n');
    fs.writeFileSync(
      path.join(tmpRepo, "rules", "01-layer.sql"),
      "-- @id: arch:no-layer-bypass\n-- @statement: Controllers must not bypass service layer.\nSELECT 1 WHERE 0;\n",
    );
    fs.writeFileSync(
      path.join(tmpRepo, ".verification", "control-plan.json"),
      JSON.stringify({ controls: [{ id: "CP-1", seam: "payment-gate", failureMode: "double charge", controlRef: "src/index.ts" }] }),
    );
    fs.writeFileSync(
      path.join(tmpRepo, ".verification", "laws", "core.laws.json"),
      JSON.stringify({ laws: [{ id: "LAW-1", statement: "Terminal states are monotonic" }] }),
    );
  });

  afterAll(() => {
    if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  test("extracts invariants across ast-scanner, repospec-bridge, and veristack-bridge and installs/removes agent harnesses", async () => {
    const host = await createPluginHost({ repoDir: tmpRepo });
    try {
      const extracted = await host.extract(tmpRepo);
      const sources = new Set(extracted.invariants.map((i) => i.source));
      expect(sources.has("ast")).toBe(true);
      expect(sources.has("repospec")).toBe(true);
      expect(sources.has("veristack")).toBe(true);

      const harnesses = host.getHarnesses();
      expect(harnesses.length).toBeGreaterThanOrEqual(4);
      const claude = harnesses.find((h) => h.id === "claude");
      expect(claude).toBeDefined();
      if (claude) {
        await claude.install(tmpRepo);
        expect((await claude.status(tmpRepo)).installed).toBe(true);
        await claude.uninstall(tmpRepo);
        expect((await claude.status(tmpRepo)).installed).toBe(false);
      }

      const reporters = host.getReporters();
      expect(reporters.some((r) => r.id === "json")).toBe(true);
      expect(host.getCommands().some((c) => c.id === "extract")).toBe(true);
    } finally {
      await host.dispose();
    }
  });
});
