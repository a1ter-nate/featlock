import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { createPluginHost } from "@featlock/core";
import harnessesPlugin from "../../../../packages/plugins/harnesses/src/index.ts";

class ToggleHarnessCmd implements fc.AsyncCommand<{ installed: boolean }, { repoRoot: string; host: Awaited<ReturnType<typeof createPluginHost>> }> {
  constructor(readonly turnOn: boolean) {}
  check(): boolean { return true; }
  async run(m: { installed: boolean }, r: { repoRoot: string; host: Awaited<ReturnType<typeof createPluginHost>> }): Promise<void> {
    const claude = r.host.getHarnesses().find((h) => h.id === "claude");
    if (!claude) throw new Error("claude harness missing");
    if (this.turnOn) await claude.install(r.repoRoot);
    else await claude.uninstall(r.repoRoot);
    m.installed = this.turnOn;
    expect((await claude.status(r.repoRoot)).installed).toBe(m.installed);
  }
}

describe("@featlock/plugin-harnesses MBT contract", () => {
  test("installing and uninstalling harnesses in any sequence keeps status accurate", async () => {
    const host = await createPluginHost({ includeBuiltins: false, plugins: [harnessesPlugin] });
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.commands([fc.boolean().map((b) => new ToggleHarnessCmd(b))], { maxCommands: 6 }),
          async (cmds) => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-harness-mbt-"));
            try {
              await fc.asyncModelRun(() => ({ model: { installed: false }, real: { repoRoot, host } }), cmds);
            } finally {
              fs.rmSync(repoRoot, { recursive: true, force: true });
            }
          },
        ),
        { numRuns: 5 },
      );
    } finally {
      await host.dispose();
    }
  });
});
