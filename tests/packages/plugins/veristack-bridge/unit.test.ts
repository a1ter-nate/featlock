import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";
import veristackPlugin from "../../../../packages/plugins/veristack-bridge/src/index.ts";

describe("@featlock/plugin-veristack-bridge unit contract", () => {
  test("scans Veristack control-plan, laws, and rungs artifacts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-vs-unit-"));
    try {
      fs.mkdirSync(path.join(dir, ".verification", "laws"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".verification", "control-plan.json"), JSON.stringify({ controls: [{ id: "CP-9", seam: "guard" }] }));
      fs.writeFileSync(path.join(dir, ".verification", "laws", "a.laws.json"), JSON.stringify({ laws: [{ id: "LAW-9", statement: "Hold" }] }));
      fs.writeFileSync(path.join(dir, ".verification", "rungs.json"), JSON.stringify({ rungs: { R0: { command: "oxlint" } } }));
      const host = await createPluginHost({ includeBuiltins: false, plugins: [veristackPlugin] });
      try {
        const out = await host.extract(dir);
        expect(out.invariants.length).toBe(3);
      } finally {
        await host.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
