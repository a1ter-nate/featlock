import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createPluginHost } from "@featlock/core";
import cliPlugin from "../../../packages/plugins/registry-cli/src/index.ts";

class RunUnknownCmd implements fc.AsyncCommand<{ exitCode: number }, { host: Awaited<ReturnType<typeof createPluginHost>> }> {
  constructor(readonly badName: string) {}
  check(): boolean { return true; }
  async run(m: { exitCode: number }, r: { host: Awaited<ReturnType<typeof createPluginHost>> }): Promise<void> {
    const code = await r.host.runCli([this.badName], process.cwd());
    expect(code).toBe(m.exitCode);
  }
}

describe("@featlock/plugin-registry-cli MBT contract", () => {
  test("unknown CLI commands consistently return exit code 2", async () => {
    const host = await createPluginHost({ includeBuiltins: false, plugins: [cliPlugin] });
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.commands([fc.constantFrom("nope-1", "bad-cmd", "unknown-xyz").map((s) => new RunUnknownCmd(s))], { maxCommands: 4 }),
          async (cmds) => {
            await fc.asyncModelRun(() => ({ model: { exitCode: 2 }, real: { host } }), cmds);
          },
        ),
        { numRuns: 5 },
      );
    } finally {
      await host.dispose();
    }
  });
});
