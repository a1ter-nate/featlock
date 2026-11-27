import { describe, expect, test } from "bun:test";
import { createPluginHost } from "@featlock/core";
import passesPlugin from "../src/index.ts";

describe("@featlock/plugin-invariant-passes unit contract", () => {
  test("registers all 4 ordered AI agent invariant discovery passes", async () => {
    expect(passesPlugin.id).toBe("featlock.invariant-passes");
    const host = await createPluginHost({ includeBuiltins: false, plugins: [passesPlugin] });
    try {
      const packets = await host.buildAgentPasses(process.cwd());
      expect(packets.length).toBe(4);
      expect(packets.map((p) => p.passId)).toEqual([
        "pass-1-feature-inventory",
        "pass-2-test-binding",
        "pass-3-invariant-mining",
        "pass-4-regression-guard-audit",
      ]);
    } finally {
      await host.dispose();
    }
  });
});
