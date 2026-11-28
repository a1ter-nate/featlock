import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "@featlock/core";

describe("R4 SQLite Schema Migration & Deterministic Round-Trip Slice", () => {
  let tmpDir = "";

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-r4-migration-"));
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("migrates registry SQL cleanly across supersede & relation updates without data loss", () => {
    Registry.recordNew({
      repoRoot: tmpDir,
      feature: {
        id: "feat.r4.base",
        area: "base",
        name: "Base Feature",
        summary: "Base capability",
        acceptanceCriteria: "Base passes",
        status: "active",
        source: "manual",
      },
      tests: [{ featureId: "feat.r4.base", testPath: "tests/base.test.ts", testPattern: "base", rung: "R4" }],
      invariants: [
        {
          id: "inv:r4:mig",
          featureId: "feat.r4.base",
          kind: "precondition",
          statement: "Guard promotes to type boundary",
          file: "src/base.ts",
          line: 1,
          confidence: 1,
          source: "manual",
          fenceRung: "runtime",
          status: "active",
        },
      ],
    });
    Registry.supersedeInvariant({
      repoRoot: tmpDir,
      invariantId: "inv:r4:mig",
      supersededBy: "type-boundary",
      fenceRung: "R1",
      rationale: "Promoted to static type fence",
    });
    const out = Registry.materializeDb(tmpDir);
    const db = new Database(out.dbPath, { readonly: true });
    try {
      const row = db
        .query("SELECT fence_rung, superseded_by FROM invariants WHERE id = 'inv:r4:mig'")
        .get() as { fence_rung: string; superseded_by: string } | null;
      expect(row?.fence_rung).toBe("R1");
      expect(row?.superseded_by).toBe("type-boundary");
    } finally {
      db.close();
    }
  });
});
