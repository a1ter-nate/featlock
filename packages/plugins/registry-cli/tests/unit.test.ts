import { describe, expect, test } from "bun:test";
import { createPluginHost } from "@featlock/core";
import cliPlugin from "../src/index.ts";

describe("@featlock/plugin-registry-cli unit contract", () => {
  test("registers all 13 CLI subcommands", async () => {
    expect(cliPlugin.id).toBe("featlock.registry-cli");
    const host = await createPluginHost({ includeBuiltins: false, plugins: [cliPlugin] });
    try {
      const ids = host.getCommands().map((c) => c.id);
      expect(ids).toContain("extract");
      expect(ids).toContain("check");
      expect(ids).toContain("sync");
      expect(ids).toContain("supersede");
      expect(ids).toContain("affected-tests");
      expect(ids).toContain("matrix");
      expect(ids.length).toBe(13);
    } finally {
      await host.dispose();
    }
  });
});
