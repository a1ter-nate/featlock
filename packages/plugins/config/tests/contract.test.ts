import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createPluginHost } from "@featlock/core";
import configPlugin from "../src/index.ts";

class FormatReportCmd implements fc.AsyncCommand<{ ok: boolean }, { host: Awaited<ReturnType<typeof createPluginHost>> }> {
  constructor(readonly ok: boolean) {}
  check(): boolean { return true; }
  async run(_model: { ok: boolean }, real: { host: Awaited<ReturnType<typeof createPluginHost>> }): Promise<void> {
    const rep = real.host.getReporters().find((r) => r.id === "json");
    if (!rep) throw new Error("json reporter missing");
    const out = rep.format({ ok: this.ok, violations: [], warnings: [], counts: { features: 1, tests: 1, invariants: 0, auditEntries: 0 } });
    expect(JSON.parse(out).ok).toBe(this.ok);
  }
}

describe("@featlock/plugin-config MBT contract", () => {
  test("json reporter serializes arbitrary CheckResult states faithfully", async () => {
    const host = await createPluginHost({ includeBuiltins: false, plugins: [configPlugin] });
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.commands([fc.boolean().map((b) => new FormatReportCmd(b))], { maxCommands: 6 }),
          async (cmds) => {
            await fc.asyncModelRun(() => ({ model: { ok: true }, real: { host } }), cmds);
          },
        ),
        { numRuns: 10 },
      );
    } finally {
      await host.dispose();
    }
  });
});
