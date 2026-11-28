import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost, Registry } from "@featlock/core";

function makeTempRepo(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-research-"));
  fs.mkdirSync(path.join(tmp, "src", "billing"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, "src", "billing", "charge.ts"),
    [
      "export function chargeUser(amount: number, user: string) {",
      '  if (!user) throw new Error("user required");',
      '  if (amount <= 0) throw new Error("positive amount required");',
      "  return amount;",
      "}",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tmp, "tests", "billing.test.ts"),
    'import { test } from "bun:test";\ntest("chargeUser validates amount and user", () => {});\n',
    "utf8",
  );
  return tmp;
}

describe("FeatLock CS Research & Uncomplect Upgrade Suite", () => {
  test("Workset 1: behavior-preserving supersede allows type-boundary promotion without ALLOW_FEATURE_REMOVAL while blocking fence downgrades", async () => {
    const tmp = makeTempRepo();
    const host = await createPluginHost({ repoDir: tmp, includeBuiltins: true });
    try {
      const ext = await host.extract(tmp);
      await host.writeRegistry(tmp, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });
      const amountInv = ext.invariants.find((i) => i.guardAnchor?.includes("amount <= 0"));
      expect(amountInv).toBeDefined();

      await host.supersedeInvariant({
        repoRoot: tmp,
        invariantId: amountInv?.id ?? "",
        supersededBy: "type-boundary",
        fenceRung: "R1",
        rationale: "PositiveAmount branded type enforces amount > 0 statically",
      });

      fs.writeFileSync(
        path.join(tmp, "src", "billing", "charge.ts"),
        [
          "export function chargeUser(amount: number, user: string) {",
          '  if (!user) throw new Error("user required");',
          "  return amount;",
          "}",
        ].join("\n"),
        "utf8",
      );

      const chk = await host.check(tmp);
      expect(chk.ok).toBe(true);

      await expect(
        host.supersedeInvariant({
          repoRoot: tmp,
          invariantId: amountInv?.id ?? "",
          supersededBy: "prose-only",
          fenceRung: "none",
        }),
      ).rejects.toThrow("Cannot downgrade fence rung");
    } finally {
      await host.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Workset 2: Reiss multi-signal anchoring auto-rebinds harmless variable renames while blocking predicate weakening", async () => {
    const tmp = makeTempRepo();
    const host = await createPluginHost({ repoDir: tmp, includeBuiltins: true });
    try {
      const ext = await host.extract(tmp);
      await host.writeRegistry(tmp, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });

      fs.writeFileSync(
        path.join(tmp, "src", "billing", "charge.ts"),
        [
          "export function chargeUser(qty: number, account: string) {",
          '  if (!account) throw new Error("account required");',
          '  if (qty <= 0) throw new Error("positive qty required");',
          "  return qty;",
          "}",
        ].join("\n"),
        "utf8",
      );
      const afterRename = await host.check(tmp);
      expect(afterRename.ok).toBe(true);

      fs.writeFileSync(
        path.join(tmp, "src", "billing", "charge.ts"),
        [
          "export function chargeUser(qty: number, account: string) {",
          '  if (!account) throw new Error("account required");',
          "  return qty;",
          "}",
        ].join("\n"),
        "utf8",
      );
      const afterDrop = await host.check(tmp);
      expect(afterDrop.ok).toBe(false);
      expect(afterDrop.violations.some((v) => v.rule === "invariant-guard-dropped-in-code")).toBe(true);
    } finally {
      await host.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Workset 3 & 4: feature_relations consistency, DoS/DoF, pairwise interaction gap, feature flags, Pre-RS provenance, and RepoSpec concern subgraph", async () => {
    const tmp = makeTempRepo();
    const host = await createPluginHost({ repoDir: tmp, includeBuiltins: true });
    try {
      fs.writeFileSync(
        path.join(tmp, "src", "billing", "flags.ts"),
        'const FEATURE_ZOMBIE_MODE = true;\nexport function run(flags: { get: (k: string) => boolean }) { return FEATURE_ZOMBIE_MODE && flags.get("ghost-toggle"); }\n',
        "utf8",
      );
      const rsDb = new Database(path.join(tmp, "repospec.sqlite"));
      rsDb.exec("CREATE TABLE edges (source TEXT, target TEXT, kind TEXT); CREATE TABLE entity_access (file TEXT, entity TEXT);");
      rsDb.exec("INSERT INTO edges VALUES ('src/billing/charge.ts', 'src/ledger/write.ts', 'imports');");
      rsDb.exec("INSERT INTO entity_access VALUES ('src/billing/charge.ts', 'Invoice');");
      rsDb.exec("INSERT INTO entity_access VALUES ('src/billing/flags.ts', 'Invoice');");
      rsDb.close();

      await host.writeRegistry(tmp, {
        features: [
          {
            id: "feat.billing",
            area: "billing",
            name: "Billing",
            summary: "Charges users",
            acceptanceCriteria: "Positive charges only",
            status: "active",
            source: "manual",
            originRef: "https://github.com/org/repo/issues/42",
            rationale: "Core monetization flow",
          },
          {
            id: "feat.invoicing",
            area: "invoicing",
            name: "Invoicing",
            summary: "Writes invoices",
            acceptanceCriteria: "Valid invoice rows",
            status: "active",
            source: "manual",
          },
        ],
        tests: [
          { featureId: "feat.billing", testPath: "tests/billing.test.ts", testPattern: "charge", rung: "R2" },
          { featureId: "feat.invoicing", testPath: "tests/invoicing.test.ts", testPattern: "invoice", rung: "R2" },
        ],
        invariants: [
          {
            id: "inv:1",
            featureId: "feat.billing",
            kind: "precondition-guard",
            statement: "no fence test",
            file: "src/billing/charge.ts",
            line: 2,
            confidence: 0.9,
            source: "manual",
            fenceRung: "none",
            status: "active",
          },
          {
            id: "inv:2",
            featureId: "feat.invoicing",
            kind: "precondition-guard",
            statement: "shared entity writer",
            file: "src/billing/flags.ts",
            line: 1,
            confidence: 0.9,
            source: "manual",
            fenceRung: "runtime",
            status: "active",
          },
        ],
        relations: [{ fromFeatureId: "feat.billing", toFeatureId: "feat.invoicing", relation: "excludes" }],
        auditLog: [],
      });
      fs.writeFileSync(path.join(tmp, "tests", "invoicing.test.ts"), 'test("invoice", () => {});\n', "utf8");

      const chk = await host.check(tmp);
      expect(chk.violations.some((v) => v.rule === "relation-excludes-conflict")).toBe(true);
      expect(chk.warnings.some((w) => w.rule === "invariant-no-fence-yet")).toBe(true);
      expect(chk.warnings.some((w) => w.rule === "feature-interaction-untested")).toBe(true);
      expect(chk.warnings.some((w) => w.rule === "feature-flag-constant")).toBe(true);
      expect(chk.warnings.some((w) => w.rule === "feature-flag-unlinked")).toBe(true);

      const concern = await host.concernSubgraph(tmp, "feat.billing");
      expect(concern?.crossBoundaryLeaks).toContain("src/billing/charge.ts -> src/ledger/write.ts");

      const matrix = await host.analyzeMatrix(tmp);
      expect(matrix.interactions.some((p) => p.pairwiseGap && p.sharedVia.includes("entity:Invoice"))).toBe(true);
    } finally {
      await host.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("Workset 5: BM25 identifier-split duplicate detection and STARTS/Elbaum prioritized affected-tests", async () => {
    const tmp = makeTempRepo();
    const host = await createPluginHost({ repoDir: tmp, includeBuiltins: true });
    try {
      const snap = {
        features: [
          {
            id: "feat.auth.jwt",
            area: "auth",
            name: "JwtBearerValidator",
            summary: "Validates signedJwtTokens and bearerClaims",
            acceptanceCriteria: "Reject expired tokens",
            status: "active" as const,
            source: "manual",
          },
          {
            id: "feat.billing.charge",
            area: "billing",
            name: "ChargeUser",
            summary: "Processes payment charges",
            acceptanceCriteria: "Positive amount",
            status: "active" as const,
            source: "manual",
          },
        ],
        tests: [
          { featureId: "feat.auth.jwt", testPath: "tests/auth.test.ts", testPattern: "jwt", rung: "R2" },
          { featureId: "feat.billing.charge", testPath: "tests/billing.test.ts", testPattern: "charge", rung: "R2" },
        ],
        invariants: [
          {
            id: "inv:bugfix:billing",
            featureId: "feat.billing.charge",
            kind: "precondition-guard",
            statement: "positive amount",
            file: "src/billing/charge.ts",
            line: 3,
            confidence: 0.95,
            source: "ast",
            rootTestPath: "tests/billing.test.ts",
            originKind: "bugfix" as const,
            status: "active" as const,
          },
        ],
        relations: [],
        auditLog: [],
      };
      const dups = Registry.findDuplicates(snap, "validate_jwt_token_bearer_claim");
      expect(dups[0]?.featureId).toBe("feat.auth.jwt");
      expect(dups[0]?.score).toBeGreaterThan(0.4);

      await host.writeRegistry(tmp, snap);
      const affected = await host.affectedTests(tmp, { changedFiles: ["src/billing/charge.ts"] });
      expect(affected.affectedFeatures).toContain("feat.billing.charge");
      expect(affected.prioritizedTests[0]?.testPath).toBe("tests/billing.test.ts");
      expect(affected.prioritizedTests[0]?.reason).toContain("bugfixGuards=1");
    } finally {
      await host.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
