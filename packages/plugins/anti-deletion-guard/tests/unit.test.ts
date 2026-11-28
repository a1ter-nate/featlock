import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";
import antiDeletionPlugin from "../src/index.ts";

describe("@featlock/plugin-anti-deletion-guard unit contract", () => {
  test("registers guarded anti-deletion plugin that cannot be disabled and checks drift/flags/empty registries", async () => {
    expect(antiDeletionPlugin.id).toBe("featlock.guard.anti-deletion");
    expect(antiDeletionPlugin.guarded).toBe(true);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-adg-unit-"));
    fs.mkdirSync(path.join(tmp, "src", "pay"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "src", "pay", "svc.ts"),
      [
        "const FEATURE_OLD = true;",
        'export function processPayment(v: number, flags: { get: (k: string) => boolean }) {',
        '  if (v <= 0) throw new Error("v");',
        '  return FEATURE_OLD && flags.get("untracked-flag") ? v : 0;',
        "}",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(tmp, "tests", "svc.test.ts"), 'test("processPayment validates v", () => {});\n', "utf8");
    const guardedHost = await createPluginHost({
      repoDir: tmp,
      includeBuiltins: true,
      operations: [{ type: "remove", target: "*" }],
    });
    const host = await createPluginHost({ repoDir: tmp, includeBuiltins: true });
    try {
      const status = guardedHost.list().find((p) => p.id === antiDeletionPlugin.id);
      expect(status?.state.status).toBe("active");

      const emptyChk = await host.check(tmp, { strictDrift: true });
      expect(emptyChk.ok).toBe(true);
      expect(emptyChk.violations).toHaveLength(0);

      await host.writeRegistry(tmp, {
        features: [
          { id: "feat.pay", area: "pay", name: "Pay", summary: "Pays", acceptanceCriteria: "ok", status: "active", source: "ast" },
        ],
        tests: [{ featureId: "feat.pay", testPath: "tests/svc.test.ts", testPattern: "processPayment", rung: "R2" }],
        invariants: [],
        auditLog: [],
      });

      const driftChk = await host.check(tmp, { strictDrift: true });
      const newInv = driftChk.violations.find((v) => v.rule === "unrecorded-new-invariant");
      expect(newInv?.message).toContain("(root test: tests/svc.test.ts)");
      const constFlag = driftChk.warnings.find((w) => w.rule === "feature-flag-constant");
      expect(constFlag?.message).toContain("Stale/constant");
      const unlinkedFlag = driftChk.warnings.find((w) => w.rule === "feature-flag-unlinked");
      expect(unlinkedFlag?.message).toContain("Undeclared");
    } finally {
      await guardedHost.dispose();
      await host.dispose();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
