import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { createPluginHost } from "@featlock/core";
import repospecPlugin from "../../../packages/plugins/repospec-bridge/src/index.ts";

class ExtractJsonCmd implements fc.AsyncCommand<{ minInvariants: number }, { host: Awaited<ReturnType<typeof createPluginHost>> }> {
  constructor(readonly invId: string) {}
  check(): boolean { return true; }
  async run(m: { minInvariants: number }, r: { host: Awaited<ReturnType<typeof createPluginHost>> }): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-rs-mbt-"));
    try {
      fs.writeFileSync(path.join(dir, "repospec.json"), JSON.stringify({ invariants: [{ id: this.invId, statement: "Hold invariant" }] }));
      const out = await r.host.extract(dir);
      expect(out.invariants.length).toBeGreaterThanOrEqual(m.minInvariants);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe("@featlock/plugin-repospec-bridge MBT contract", () => {
  test("extracts invariants from arbitrary repospec.json payloads", async () => {
    const host = await createPluginHost({ includeBuiltins: false, plugins: [repospecPlugin] });
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.commands([fc.constantFrom("inv-a", "inv-b", "inv-c").map((id) => new ExtractJsonCmd(id))], { maxCommands: 4 }),
          async (cmds) => {
            await fc.asyncModelRun(() => ({ model: { minInvariants: 1 }, real: { host } }), cmds);
          },
        ),
        { numRuns: 5 },
      );
    } finally {
      await host.dispose();
    }
  });
});
