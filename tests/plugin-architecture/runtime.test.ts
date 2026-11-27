import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost, State } from "@featlock/core";
import { Plugin } from "@featlock/plugin";

const DEMO_TOGGLE_DIR = path.resolve(import.meta.dir, "../../examples/plugins/demo-toggle");

describe("FeatLock Plugin Runtime, Fault Isolation, Guarded Policy & Demo Toggle ON/OFF", () => {
  let tmpDir = "";

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-rt-"));
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "demo-app", version: "1.0.0" }));
    fs.writeFileSync(
      path.join(tmpDir, "src", "orders.ts"),
      'export function submitOrder(amount: number): number {\n  if (amount <= 0) throw new RangeError("amount must be positive");\n  return amount;\n}\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, "tests", "orders.test.ts"),
      'import { test, expect } from "bun:test";\ntest("submitOrder validates positive amounts", () => { expect(1).toBe(1); });\n',
    );
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("State.create replays cleanly on disposal without mutating prior snapshots", () => {
    const state = State.create<string[], { add: (v: string) => void }>({
      name: "test.replay",
      initial: () => [],
      editor: (draft) => ({ add: (v) => draft.push(v) }),
    });
    const empty = state.get();
    const regA = state.transform((ed) => ed.add("alpha"));
    const regB = state.transform((ed) => ed.add("beta"));
    const both = state.get();
    expect(both).toEqual(["alpha", "beta"]);
    expect(empty).toEqual([]);
    regA.dispose();
    expect(state.get()).toEqual(["beta"]);
    expect(both).toEqual(["alpha", "beta"]);
    regB.dispose();
  });

  test("Fault isolation detaches crashing plugin across all domains while healthy & guarded plugins survive", async () => {
    const faulty = Plugin.define({
      id: "acme.faulty",
      async setup(ctx) {
        await ctx.extractor.transform((ed) => {
          ed.add({
            id: "acme.faulty.ext",
            label: "Should Be Detached",
            extract: () => ({
              features: [
                {
                  id: "feat.should.not.exist",
                  area: "bad",
                  name: "Bad",
                  summary: "Bad",
                  acceptanceCriteria: "Bad",
                  status: "active",
                  source: "faulty",
                },
              ],
              tests: [],
              invariants: [],
            }),
          });
        });
        await ctx.guard.transform(() => {
          throw new Error("simulated plugin transform crash");
        });
      },
    });

    const host = await createPluginHost({ repoDir: tmpDir, plugins: [faulty] });
    try {
      const statuses = host.list();
      const faultySlot = statuses.find((s) => s.id === "acme.faulty");
      expect(faultySlot?.state.status).toBe("failed");
      const out = await host.extract(tmpDir);
      expect(out.features.some((f) => f.id === "feat.should.not.exist")).toBe(false);
    } finally {
      await host.dispose();
    }

    const lockedHost = await createPluginHost({
      repoDir: tmpDir,
      operations: [{ type: "remove", target: "*" }],
    });
    try {
      const guardedActive = lockedHost.list().filter((p) => p.guarded && p.state.status === "active");
      expect(guardedActive.length).toBeGreaterThanOrEqual(1);
      expect(guardedActive.some((p) => p.id === "featlock.guard.anti-deletion")).toBe(true);
    } finally {
      await lockedHost.dispose();
    }
  });

  test("Easy ON/OFF proof: @featlock/plugin-demo-toggle adds feature, invariant & command when ON and leaves zero residue when OFF", async () => {
    const hostOff = await createPluginHost({ repoDir: tmpDir });
    try {
      const offExtract = await hostOff.extract(tmpDir);
      expect(offExtract.features.some((f) => f.id === "feat.demo.toggle-canary")).toBe(false);
      expect(hostOff.getCommands().some((c) => c.id === "demo-ping")).toBe(false);
    } finally {
      await hostOff.dispose();
    }

    const hostOn = await createPluginHost({
      repoDir: tmpDir,
      operations: [{ type: "add", target: DEMO_TOGGLE_DIR }],
    });
    try {
      const onExtract = await hostOn.extract(tmpDir);
      expect(onExtract.features.some((f) => f.id === "feat.demo.toggle-canary")).toBe(true);
      expect(onExtract.invariants.some((i) => i.id === "inv:demo:toggle-canary")).toBe(true);
      expect(hostOn.getCommands().some((c) => c.id === "demo-ping")).toBe(true);

      await hostOn.activate([], [{ type: "remove", target: "featlock.demo.toggle" }]);
      const afterOff = await hostOn.extract(tmpDir);
      expect(afterOff.features.some((f) => f.id === "feat.demo.toggle-canary")).toBe(false);
      expect(hostOn.getCommands().some((c) => c.id === "demo-ping")).toBe(false);
    } finally {
      await hostOn.dispose();
    }
  });
});
