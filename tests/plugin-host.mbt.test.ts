import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createPluginHost, type PluginHostInstance } from "@featlock/core";
import { Plugin, type FeatlockPlugin } from "@featlock/plugin";

interface HostModel {
  readonly extraIds: Set<string>;
  readonly removedIds: Set<string>;
}

interface HostReal {
  readonly host: PluginHostInstance;
  readonly pluginsById: Map<string, FeatlockPlugin>;
}

function makeTempPlugin(id: string): FeatlockPlugin {
  return Plugin.define({
    id,
    async setup(ctx) {
      await ctx.command.transform((ed) => {
        ed.add({ id: `cmd-${id}`, description: `Dynamic command for ${id}`, run: async () => 0 });
      });
    },
  });
}

class ActivateExtraCmd implements fc.AsyncCommand<HostModel, HostReal> {
  constructor(readonly id: string) {}
  check(): boolean {
    return true;
  }
  async run(m: HostModel, r: HostReal): Promise<void> {
    m.extraIds.add(this.id);
    m.removedIds.delete(this.id);
    const activePlugins = [...m.extraIds].map((pid) => r.pluginsById.get(pid)).filter(Boolean);
    const ops = [...m.removedIds].map((target) => ({ type: "remove" as const, target }));
    await r.host.activate(activePlugins, ops);
    const ids = r.host.list().map((p) => p.id);
    expect(ids.includes(this.id)).toBe(true);
    expect(ids.includes("featlock.guard.anti-deletion")).toBe(true);
  }
  toString(): string {
    return `ActivateExtra(${this.id})`;
  }
}

class AttemptRemoveGuardCmd implements fc.AsyncCommand<HostModel, HostReal> {
  check(): boolean {
    return true;
  }
  async run(m: HostModel, r: HostReal): Promise<void> {
    const activePlugins = [...m.extraIds].map((pid) => r.pluginsById.get(pid)).filter(Boolean);
    await r.host.activate(activePlugins, [{ type: "remove", target: "featlock.guard.anti-deletion" }, { type: "remove", target: "*" }]);
    const list = r.host.list();
    expect(list.some((p) => p.id === "featlock.guard.anti-deletion" && p.state.status === "active")).toBe(true);
  }
  toString(): string {
    return "AttemptRemoveGuard()";
  }
}

describe("Stateful MBT: PluginHost Lifecycle & Guarded Invariance", () => {
  test("arbitrary sequences of plugin activation and guarded-removal attempts preserve anti-deletion guard", async () => {
    const idArb = fc.constantFrom("acme.one", "acme.two", "acme.three");
    const commands = [
      idArb.map((id) => new ActivateExtraCmd(id)),
      fc.constant(new AttemptRemoveGuardCmd()),
    ];

    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 8 }), async (cmds) => {
        const host = await createPluginHost();
        const pluginsById = new Map<string, FeatlockPlugin>([
          ["acme.one", makeTempPlugin("acme.one")],
          ["acme.two", makeTempPlugin("acme.two")],
          ["acme.three", makeTempPlugin("acme.three")],
        ]);
        try {
          const setup = () => ({
            model: { extraIds: new Set<string>(), removedIds: new Set<string>() } as HostModel,
            real: { host, pluginsById } as HostReal,
          });
          await fc.asyncModelRun(setup, cmds);
        } finally {
          await host.dispose();
        }
      }),
      { numRuns: 10 },
    );
  });
});
