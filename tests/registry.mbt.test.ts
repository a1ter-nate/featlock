import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { Registry } from "@featlock/core";

interface RegistryModel {
  readonly features: Map<string, { area: string; summary: string; status: "active" | "removed" }>;
  auditCount: number;
}

interface RegistryReal {
  readonly repoRoot: string;
}

class AddFeatureCmd implements fc.Command<RegistryModel, RegistryReal> {
  constructor(
    readonly id: string,
    readonly area: string,
    readonly summary: string,
  ) {}
  check(): boolean {
    return true;
  }
  run(m: RegistryModel, r: RegistryReal): void {
    const snap = Registry.recordNew({
      repoRoot: r.repoRoot,
      feature: {
        id: this.id,
        area: this.area,
        name: `Feature ${this.id}`,
        summary: this.summary,
        acceptanceCriteria: "Verified by MBT",
        status: "active",
        source: "manual",
      },
      tests: [{ featureId: this.id, testPath: `tests/${this.area}.test.ts`, testPattern: this.id, rung: "R2" }],
    });
    m.features.set(this.id, { area: this.area, summary: this.summary, status: "active" });
    m.auditCount += 1;
    expect(snap.features.length).toBe(m.features.size);
    expect(snap.auditLog.length).toBe(m.auditCount);
  }
  toString(): string {
    return `AddFeature(${this.id})`;
  }
}

class ImproveFeatureCmd implements fc.Command<RegistryModel, RegistryReal> {
  constructor(
    readonly id: string,
    readonly note: string,
  ) {}
  check(m: Readonly<RegistryModel>): boolean {
    return m.features.has(this.id);
  }
  run(m: RegistryModel, r: RegistryReal): void {
    const snap = Registry.recordImprovement({
      repoRoot: r.repoRoot,
      featureId: this.id,
      summary: this.note,
    });
    const prev = m.features.get(this.id);
    if (prev) m.features.set(this.id, { ...prev, summary: `${prev.summary} | ${this.note}` });
    m.auditCount += 1;
    const found = snap.features.find((f) => f.id === this.id);
    expect(found?.summary).toBe(m.features.get(this.id)?.summary);
    expect(snap.auditLog.length).toBe(m.auditCount);
  }
  toString(): string {
    return `ImproveFeature(${this.id})`;
  }
}

class MaterializeVerifyCmd implements fc.Command<RegistryModel, RegistryReal> {
  check(): boolean {
    return true;
  }
  run(m: RegistryModel, r: RegistryReal): void {
    const mat = Registry.materializeDb(r.repoRoot);
    expect(mat.counts.features).toBe(m.features.size);
    expect(mat.counts.auditEntries).toBe(m.auditCount);
  }
  toString(): string {
    return "MaterializeVerify()";
  }
}

describe("Stateful MBT: Registry Persistence & SQLite Materialization", () => {
  test("arbitrary sequences of recordNew, recordImprovement, and materializeDb match the reference model", () => {
    const idArb = fc.constantFrom("feat.alpha", "feat.beta", "feat.gamma", "feat.delta");
    const areaArb = fc.constantFrom("core", "billing", "auth");
    const textArb = fc.constantFrom("handles input", "validates bounds", "persists state");

    const allCommands = [
      fc.tuple(idArb, areaArb, textArb).map(([id, area, text]) => new AddFeatureCmd(id, area, text)),
      fc.tuple(idArb, textArb).map(([id, text]) => new ImproveFeatureCmd(id, text)),
      fc.constant(new MaterializeVerifyCmd()),
    ];

    fc.assert(
      fc.property(fc.commands(allCommands, { maxCommands: 14 }), (cmds) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-mbt-"));
        try {
          const s = () => ({
            model: { features: new Map(), auditCount: 0 } as RegistryModel,
            real: { repoRoot } as RegistryReal,
          });
          fc.modelRun(s, cmds);
        } finally {
          fs.rmSync(repoRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 20 },
    );
  });
});
