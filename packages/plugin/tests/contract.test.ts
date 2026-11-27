import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { definePlugin, isFeatlockPlugin } from "@featlock/plugin";

class BrandPluginCmd implements fc.Command<Set<string>, Set<string>> {
  constructor(readonly id: string) {}
  check(): boolean { return true; }
  run(model: Set<string>, real: Set<string>): void {
    const def = definePlugin({ id: this.id, setup() {} });
    expect(isFeatlockPlugin(def)).toBe(true);
    model.add(def.id);
    real.add(def.id);
    expect(real.size).toBe(model.size);
  }
}

describe("@featlock/plugin MBT contract", () => {
  test("Plugin.define preserves branded identity across arbitrary command sequences", () => {
    fc.assert(
      fc.property(
        fc.commands([fc.stringMatching(/^[a-z]{3,8}\.[a-z]{3,8}$/).map((id) => new BrandPluginCmd(id))], { maxCommands: 8 }),
        (cmds) => {
          fc.modelRun(() => ({ model: new Set<string>(), real: new Set<string>() }), cmds);
        },
      ),
      { numRuns: 20 },
    );
  });
});
