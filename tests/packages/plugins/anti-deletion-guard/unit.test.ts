import { describe, expect, test } from "bun:test";
import { createPluginHost } from "@featlock/core";
import antiDeletionPlugin from "../../../packages/plugins/anti-deletion-guard/src/index.ts";

describe("@featlock/plugin-anti-deletion-guard unit contract", () => {
  test("registers guarded anti-deletion plugin that cannot be disabled", async () => {
    expect(antiDeletionPlugin.id).toBe("featlock.guard.anti-deletion");
    expect(antiDeletionPlugin.guarded).toBe(true);
    const host = await createPluginHost({ operations: [{ type: "remove", target: "featlock.guard.anti-deletion" }] });
    try {
      expect(host.list().some((p) => p.id === antiDeletionPlugin.id && p.state.status === "active")).toBe(true);
    } finally {
      await host.dispose();
    }
  });
});
