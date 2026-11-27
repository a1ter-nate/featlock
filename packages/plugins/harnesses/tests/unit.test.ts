import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";
import harnessesPlugin from "../src/index.ts";

describe("@featlock/plugin-harnesses unit contract", () => {
  test("registers claude, cursor, codex, and copilot harnesses and wires/unwires configs safely", async () => {
    expect(harnessesPlugin.id).toBe("featlock.harnesses");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-harness-unit-"));
    const host = await createPluginHost({ includeBuiltins: false, plugins: [harnessesPlugin] });
    try {
      const harnesses = host.getHarnesses();
      const ids = harnesses.map((h) => h.id);
      expect(ids).toEqual(expect.arrayContaining(["claude", "cursor", "codex", "copilot"]));

      fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
      fs.writeFileSync(
        path.join(tmp, ".claude", "settings.local.json"),
        JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-guard" }] }] } }, null, 2),
        "utf8",
      );

      for (const h of harnesses) await h.install(tmp);

      const claudeCfg = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.local.json"), "utf8")) as {
        hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
      };
      expect(claudeCfg.hooks.Stop).toHaveLength(2);
      expect(JSON.stringify(claudeCfg)).toContain("existing-guard");
      expect(JSON.stringify(claudeCfg)).toContain(".claude/hooks/feature-guard.mjs");

      const codexCfg = fs.readFileSync(path.join(tmp, ".codex", "hooks.json"), "utf8");
      const cursorCfg = fs.readFileSync(path.join(tmp, ".cursor", "hooks.json"), "utf8");
      expect(codexCfg).toContain(".codex/hooks/feature-guard.mjs");
      expect(cursorCfg).toContain(".cursor/hooks/feature-guard.mjs");

      const hookScript = fs.readFileSync(path.join(tmp, ".claude", "hooks", "feature-guard.mjs"), "utf8");
      expect(hookScript).toContain("node_modules/.bin/featlock");

      const claudeHarness = harnesses.find((h) => h.id === "claude");
      expect((await claudeHarness?.status(tmp))?.installed).toBe(true);

      for (const h of harnesses) await h.uninstall(tmp);
      const afterClaude = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.local.json"), "utf8")) as {
        hooks: { Stop: unknown[] };
      };
      expect(afterClaude.hooks.Stop).toHaveLength(1);
      expect(JSON.stringify(afterClaude)).toContain("existing-guard");
      expect(JSON.stringify(afterClaude)).not.toContain("feature-guard.mjs");
      expect((await claudeHarness?.status(tmp))?.installed).toBe(false);
    } finally {
      await host.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
