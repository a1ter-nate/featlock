import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createPluginHost } from "@featlock/core";

class RemoveSelectorCmd implements fc.AsyncCommand<{ guardedAlive: boolean }, { repoRoot: string }> {
  constructor(readonly selector: string) {}
  check(): boolean { return true; }
  async run(model: { guardedAlive: boolean }): Promise<void> {
    const host = await createPluginHost({ operations: [{ type: "remove", target: this.selector }] });
    try {
      const alive = host.list().some((p) => p.id === "featlock.guard.anti-deletion" && p.state.status === "active");
      expect(alive).toBe(model.guardedAlive);
    } finally {
      await host.dispose();
    }
  }
}

describe("@featlock/plugin-anti-deletion-guard MBT contract", () => {
  test("anti-deletion guard remains active under arbitrary remove selectors", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.commands(
          [fc.constantFrom("*", "featlock.*", "featlock.guard.anti-deletion").map((s) => new RemoveSelectorCmd(s))],
          { maxCommands: 4 },
        ),
        async (cmds) => {
          await fc.asyncModelRun(() => ({ model: { guardedAlive: true }, real: { repoRoot: process.cwd() } }), cmds);
        },
      ),
      { numRuns: 5 },
    );
  });
});
