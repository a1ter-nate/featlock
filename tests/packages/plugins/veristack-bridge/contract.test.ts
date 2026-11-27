import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { createPluginHost } from "@featlock/core";
import veristackPlugin from "../../../../packages/plugins/veristack-bridge/src/index.ts";

class ScanPlanCmd implements fc.AsyncCommand<{ expected: number }, { host: Awaited<ReturnType<typeof createPluginHost>> }> {
  constructor(readonly controlId: string) {}
  check(): boolean { return true; }
  async run(m: { expected: number }, r: { host: Awaited<ReturnType<typeof createPluginHost>> }): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-vs-mbt-"));
    try {
      fs.mkdirSync(path.join(dir, ".verification"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".verification", "control-plan.json"), JSON.stringify({ controls: [{ id: this.controlId, seam: "core" }] }));
      const out = await r.host.extract(dir);
      expect(out.invariants.length).toBe(m.expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe("@featlock/plugin-veristack-bridge MBT contract", () => {
  test("extracts control-plan invariants consistently across arbitrary control ids", async () => {
    const host = await createPluginHost({ includeBuiltins: false, plugins: [veristackPlugin] });
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.commands([fc.constantFrom("CP-1", "CP-2", "CP-3").map((id) => new ScanPlanCmd(id))], { maxCommands: 4 }),
          async (cmds) => {
            await fc.asyncModelRun(() => ({ model: { expected: 1 }, real: { host } }), cmds);
          },
        ),
        { numRuns: 5 },
      );
    } finally {
      await host.dispose();
    }
  });
});
