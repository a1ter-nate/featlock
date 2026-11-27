import { describe, expect, test } from "bun:test";
import { createPluginHost } from "@featlock/core";
import passesPlugin from "../../../packages/plugins/invariant-passes/src/index.ts";

describe("@featlock/plugin-invariant-passes unit contract", () => {
  test("registers all 4 ordered AI agent invariant discovery passes", async () => {
    expect(passesPlugin.id).toBe("featlock.invariant-passes");
    const host = await createPluginHost({ includeBuiltins: false, plugins: [passesPlugin] });
    try {
      const packets = await host.buildAgentPasses(process.cwd());
      expect(packets.length).toBe(4);
      expect(packets.map((p) => p.passId)).toEqual(["pass-1-surfaces", "pass-2-domain-invariants", "pass-3-state-and-auth", "pass-4-test-oracle-audit"]);
    } finally {
      await host.dispose();
    }
  });
});
