import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost, Registry } from "@featlock/core";

describe("SQLite Anti-Deletion Triggers, Git Diff Guards, Dup Detection & Agent Passes [REQ-FLK-GUARD-01]", () => {
  let repoDir = "";

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-guard-"));
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "tests"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "billing.ts"), 'export function charge(n: number) { if (n <= 0) throw new Error("neg"); return n; }\n');
    fs.writeFileSync(path.join(repoDir, "tests", "billing.test.ts"), 'test("charges positive amounts", () => {});\n');
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir, stdio: "ignore" });

    Registry.recordNew({
      repoRoot: repoDir,
      feature: {
        id: "feat.billing.charge",
        area: "billing",
        name: "Billing charge processor",
        summary: "Charges positive invoice amounts with fail-closed validation",
        acceptanceCriteria: "Rejects zero/negative amounts and returns charged total.",
        status: "active",
        source: "manual",
      },
      tests: [{ featureId: "feat.billing.charge", testPath: "tests/billing.test.ts", testPattern: "charges positive amounts", rung: "R2" }],
      invariants: [
        {
          id: "inv:billing:positive-only",
          featureId: "feat.billing.charge",
          kind: "precondition-guard",
          statement: "Billing charge rejects amount <= 0",
          file: "src/billing.ts",
          line: 1,
          confidence: 1,
          source: "ast",
          status: "active",
        },
      ],
    });
    execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  });

  afterAll(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  test("SQLite BEFORE DELETE triggers abort direct deletion of active features, tests, and invariants", () => {
    const { dbPath } = Registry.materializeDb(repoDir);
    const db = new Database(dbPath);
    try {
      expect(() => db.exec("DELETE FROM features WHERE id = 'feat.billing.charge';")).toThrow(/FEATLOCK_TRIGGER_BLOCK/);
      expect(() => db.exec("DELETE FROM feature_tests WHERE feature_id = 'feat.billing.charge';")).toThrow(/FEATLOCK_TRIGGER_BLOCK/);
      expect(() => db.exec("DELETE FROM invariants WHERE id = 'inv:billing:positive-only';")).toThrow(/FEATLOCK_TRIGGER_BLOCK/);
    } finally {
      db.close();
    }
  });

  test("Git-diff anti-deletion guard blocks silent deletion, warns loudly on ADR-approved removal, and logs improvements", async () => {
    const host = await createPluginHost({ repoDir });
    try {
      const clean = await host.check(repoDir);
      expect(clean.ok).toBe(true);
      expect(clean.warnings.some((w) => w.rule === "linked-test-not-skipped")).toBe(false);
      expect(clean.warnings.some((w) => w.rule === "staged-changes-record-feature")).toBe(false);

      fs.writeFileSync(path.join(repoDir, "tests", "billing.test.ts"), 'test.skip("charges positive amounts", () => {});\n');
      const skippedWarn = await host.check(repoDir);
      expect(skippedWarn.warnings.some((w) => w.rule === "linked-test-not-skipped")).toBe(true);
      fs.writeFileSync(path.join(repoDir, "tests", "billing.test.ts"), 'test("charges positive amounts", () => {});\n');

      fs.writeFileSync(path.join(repoDir, "src", "billing.ts"), 'export function charge(n: number) { if (n <= 0) throw new Error("neg"); return n + 1; }\n');
      execFileSync("git", ["add", "src/billing.ts"], { cwd: repoDir, stdio: "ignore" });
      const stagedWarn = await host.check(repoDir);
      expect(stagedWarn.warnings.some((w) => w.rule === "staged-changes-record-feature")).toBe(true);
      execFileSync("git", ["reset", "HEAD", "src/billing.ts"], { cwd: repoDir, stdio: "ignore" });
      execFileSync("git", ["checkout", "--", "src/billing.ts"], { cwd: repoDir, stdio: "ignore" });

      const dups = await host.checkDup(repoDir, "billing invoice charge processor");
      expect(dups.length).toBeGreaterThan(0);
      expect(dups[0]?.featureId).toBe("feat.billing.charge");

      const passes = await host.buildAgentPasses(repoDir);
      expect(passes.length).toBe(4);

      Registry.writeSql(repoDir, { features: [], tests: [], invariants: [], auditLog: [] });
      const deletedRes = await host.check(repoDir);
      expect(deletedRes.ok).toBe(false);
      expect(deletedRes.violations.some((v) => v.rule === "no-silent-feature-deletion")).toBe(true);
      expect(deletedRes.violations.some((v) => v.rule === "no-silent-invariant-deletion")).toBe(true);

      Registry.writeSql(repoDir, {
        features: [
          {
            id: "feat.billing.charge",
            area: "billing",
            name: "Billing charge processor",
            summary: "Retired",
            acceptanceCriteria: "Retired",
            status: "removed",
            source: "manual",
            adrRef: "ADR-007",
            removalReason: "Replaced by Stripe Checkout",
          },
        ],
        tests: [],
        invariants: [
          {
            id: "inv:billing:positive-only",
            featureId: "feat.billing.charge",
            kind: "precondition-guard",
            statement: "Retired",
            file: "src/billing.ts",
            line: 1,
            confidence: 1,
            source: "ast",
            status: "removed",
          },
        ],
        auditLog: [],
      });
      const unapproved = await host.check(repoDir, { allowRemoval: false });
      expect(unapproved.ok).toBe(false);
      expect(unapproved.violations.some((v) => v.rule === "feature-removal-requires-adr")).toBe(true);

      const approved = await host.check(repoDir, { allowRemoval: true });
      expect(approved.ok).toBe(true);
      expect(approved.warnings.some((w) => w.rule === "loud-feature-removal-warning")).toBe(true);

      Registry.writeSql(repoDir, {
        features: [
          {
            id: "feat.billing.charge",
            area: "billing",
            name: "Billing charge processor",
            summary: "Retired",
            acceptanceCriteria: "Retired",
            status: "removed",
            source: "manual",
            adrRef: "ADR-007",
            removalReason: "   ",
          },
        ],
        tests: [],
        invariants: [],
        auditLog: [],
      });
      const missingReason = await host.check(repoDir, { allowRemoval: true });
      expect(missingReason.ok).toBe(false);
      expect(missingReason.violations.some((v) => v.rule === "feature-removal-requires-adr")).toBe(true);

      execFileSync("git", ["checkout", "--", "features/registry.sql"], { cwd: repoDir, stdio: "ignore" });
      const improved = Registry.recordImprovement({
        repoRoot: repoDir,
        featureId: "feat.billing.charge",
        summary: "Added idempotency key support",
      });
      expect(improved.auditLog.some((a) => a.action === "improved" && a.featureId === "feat.billing.charge")).toBe(true);
    } finally {
      await host.dispose();
    }
  });
});
