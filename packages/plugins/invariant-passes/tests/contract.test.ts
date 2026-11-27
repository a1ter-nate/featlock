import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createPluginHost } from "@featlock/core";
import passesPlugin from "../src/index.ts";

class BuildPassesCmd implements fc.AsyncCommand<{ expectedCount: number }, { host: Awaited<ReturnType<typeof createPluginHost>> }> {
  check(): boolean { return true; }
  async run(m: { expectedCount: number }, r: { host: Awaited<ReturnType<typeof createPluginHost>> }): Promise<void> {
    const packets = await r.host.buildAgentPasses(process.cwd());
    expect(packets.length).toBe(m.expectedCount);
  }
}

describe("@featlock/plugin-invariant-passes MBT contract", () => {
  test("agent-pass generation is idempotent across repeated invocations", async () => {
    const host = await createPluginHost({ includeBuiltins: false, plugins: [passesPlugin] });
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.commands([fc.constant(new BuildPassesCmd())], { maxCommands: 3 }),
          async (cmds) => {
            await fc.asyncModelRun(() => ({ model: { expectedCount: 4 }, real: { host } }), cmds);
          },
        ),
        { numRuns: 3 },
      );
    } finally {
      await host.dispose();
    }
  });
});
