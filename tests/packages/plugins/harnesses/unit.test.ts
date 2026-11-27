import { describe, expect, test } from "bun:test";
import { createPluginHost } from "@featlock/core";
import harnessesPlugin from "../../../../packages/plugins/harnesses/src/index.ts";

describe("@featlock/plugin-harnesses unit contract", () => {
  test("registers claude, cursor, codex, and copilot agent harnesses", async () => {
    expect(harnessesPlugin.id).toBe("featlock.harnesses");
    const host = await createPluginHost({ includeBuiltins: false, plugins: [harnessesPlugin] });
    try {
      const ids = host.getHarnesses().map((h) => h.id);
      expect(ids).toContain("claude");
      expect(ids).toContain("cursor");
      expect(ids).toContain("codex");
      expect(ids).toContain("copilot");
    } finally {
      await host.dispose();
    }
  });
});
