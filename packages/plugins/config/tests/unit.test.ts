import { describe, expect, test } from "bun:test";
import { createPluginHost } from "@featlock/core";
import configPlugin from "../src/index.ts";

describe("@featlock/plugin-config unit contract", () => {
  test("registers json reporter", async () => {
    expect(configPlugin.id).toBe("featlock.config");
    const host = await createPluginHost({ includeBuiltins: false, plugins: [configPlugin] });
    try {
      const ids = host.getReporters().map((r) => r.id);
      expect(ids).toContain("json");
    } finally {
      await host.dispose();
    }
  });
});
