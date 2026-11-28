import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost, State } from "@featlock/core";
import { Plugin } from "@featlock/plugin";

const DEMO_TOGGLE_DIR = path.resolve(import.meta.dir, "../../examples/plugins/demo-toggle");
const CUSTOM_UI_DIR = path.resolve(import.meta.dir, "../../examples/plugins/custom-ui-viz");

describe("FeatLock Plugin Architecture Conformance (Laws 5-8): Replay, Composition, Fault Isolation & Custom UI Plugins", () => {
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

  test("Law 5: Replayable State replays cleanly on disposal without mutating prior snapshots", () => {
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

  test("Law 5b: Removing a non-guarded built-in plugin removes its behavior cleanly", async () => {
    const hostNoAst = await createPluginHost({
      repoDir: tmpDir,
      operations: [{ type: "remove", target: "featlock.ast-scanner" }],
    });
    try {
      expect(hostNoAst.list().some((p) => p.id === "featlock.ast-scanner")).toBe(false);
      const out = await hostNoAst.extract(tmpDir);
      expect(out.features).toEqual([]);
    } finally {
      await hostNoAst.dispose();
    }
  });

  test("Law 6: Independent UI & domain plugins compose tabs, widgets, dataProviders, themes, and custom renderers without clobbering", async () => {
    const uiPluginA = Plugin.define({
      id: "acme.ui.alpha",
      async setup(ctx) {
        await ctx.studio.transform((ed) => {
          ed.addDataProvider({ id: "alphaMetric", provide: (d) => d.counts.features * 10 });
          ed.addWidget({ id: "alpha-w", title: "Alpha Widget", renderHtml: (d) => `<b>${String(d.extensions.alphaMetric)}</b>` });
          ed.addTab({ id: "alpha-tab", label: "Alpha Tab", renderHtml: () => "<section>Alpha Viz</section>" });
          ed.setTheme({ accent: "#22d3ee" });
        });
      },
    });
    const uiPluginB = Plugin.define({
      id: "acme.ui.beta",
      async setup(ctx) {
        await ctx.studio.transform((ed) => {
          ed.addWidget({ id: "beta-w", title: "Beta Widget", renderHtml: () => "<i>Beta KPI</i>" });
          ed.addTab({ id: "beta-tab", label: "Beta Tab", renderHtml: () => "<section>Beta Viz</section>" });
          ed.addCss(".beta-marker{display:block;}");
        });
      },
    });

    const host = await createPluginHost({ repoDir: tmpDir, plugins: [uiPluginA, uiPluginB] });
    try {
      const ext = await host.extract(tmpDir);
      await host.writeRegistry(tmpDir, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });
      const html = await host.renderStudio(tmpDir);
      expect(html).toContain("Alpha Widget");
      expect(html).toContain("Beta Widget");
      expect(html).toContain("Alpha Tab");
      expect(html).toContain("Beta Tab");
      expect(html).toContain("--accent:#22d3ee;");
      expect(html).toContain(".beta-marker{display:block;}");
    } finally {
      await host.dispose();
    }
  });

  test("Law 7: Fault isolation detaches crashing plugin across extractor & studio domains while healthy & guarded plugins survive", async () => {
    const faulty = Plugin.define({
      id: "acme.faulty",
      async setup(ctx) {
        await ctx.studio.transform((ed) => {
          ed.addTab({ id: "faulty-tab", label: "Should Be Detached", renderHtml: () => "<div>bad</div>" });
        });
        await ctx.guard.transform(() => {
          throw new Error("simulated plugin transform crash");
        });
      },
    });

    const host = await createPluginHost({ repoDir: tmpDir, plugins: [faulty] });
    try {
      const faultySlot = host.list().find((s) => s.id === "acme.faulty");
      expect(faultySlot?.status).toBe("failed");
      expect(faultySlot?.state.status).toBe("failed");
      const html = await host.renderStudio(tmpDir);
      expect(html).not.toContain("Should Be Detached");
    } finally {
      await host.dispose();
    }

    const lockedHost = await createPluginHost({
      repoDir: tmpDir,
      operations: [{ type: "remove", target: "*" }],
    });
    try {
      const guardedActive = lockedHost.list().filter((p) => p.guarded && p.status === "active");
      expect(guardedActive.length).toBeGreaterThanOrEqual(1);
      expect(guardedActive.some((p) => p.id === "featlock.guard.anti-deletion")).toBe(true);
    } finally {
      await lockedHost.dispose();
    }
  });

  test("Law 8: External package plugins (demo-toggle & custom-ui-viz) load via package.json exports and leave zero residue when removed", async () => {
    const hostOn = await createPluginHost({
      repoDir: tmpDir,
      operations: [
        { type: "add", target: DEMO_TOGGLE_DIR },
        { type: "add", target: CUSTOM_UI_DIR },
      ],
    });
    try {
      const onExtract = await hostOn.extract(tmpDir);
      expect(onExtract.features.some((f) => f.id === "feat.demo.toggle-canary")).toBe(true);
      expect(hostOn.getCommands().some((c) => c.id === "demo-ping")).toBe(true);

      const studioHtml = await hostOn.renderStudio(tmpDir);
      expect(studioHtml).toContain("Area Fence Coverage");
      expect(studioHtml).toContain("Fence Heatmap");

      const customBoard = await hostOn.renderStudio(tmpDir, { rendererId: "custom-minimal-board" });
      expect(customBoard).toContain("Custom FeatLock Board");

      await hostOn.activate([], [
        { type: "remove", target: "featlock.demo.toggle" },
        { type: "remove", target: "featlock.example.custom-ui-viz" },
      ]);
      const afterOff = await hostOn.extract(tmpDir);
      expect(afterOff.features.some((f) => f.id === "feat.demo.toggle-canary")).toBe(false);
      const studioAfterOff = await hostOn.renderStudio(tmpDir);
      expect(studioAfterOff).not.toContain("Fence Heatmap");
    } finally {
      await hostOn.dispose();
    }
  });
});
