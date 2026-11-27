import { describe, expect, test } from "bun:test";
import { definePlugin, isFeatlockPlugin, Plugin } from "@featlock/plugin";

describe("@featlock/plugin unit contract", () => {
  test("Plugin.define brands valid plugins and rejects empty ids", () => {
    const plugin = Plugin.define({ id: "sample.unit.plugin", setup() {} });
    expect(isFeatlockPlugin(plugin)).toBe(true);
    expect(plugin.id).toBe("sample.unit.plugin");
    expect(isFeatlockPlugin({ id: "fake" })).toBe(false);
    expect(() => definePlugin({ id: "   ", setup() {} })).toThrow();
  });
});
