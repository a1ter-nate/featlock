import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost, Registry } from "@featlock/core";

function writeTree(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  }
}

interface DeepRegressionCase {
  readonly name: string;
  readonly goodFiles: Readonly<Record<string, string>>;
  readonly buggyOverlay: Readonly<Record<string, string>>;
  readonly targetFile: string;
  readonly expectedRootTest: string;
}

const DEEP_POST_AI_REGRESSIONS: readonly DeepRegressionCase[] = [
  {
    name: "Better-Auth b87f41f (Post-AI TS): dropping APIError.from single-role RBAC guard",
    goodFiles: {
      "packages/better-auth/src/plugins/organization/routes/crud-access-control.ts":
        'export const normalizeRoleName = (role: string) => {\n  const roleName = role.trim().toLowerCase();\n  const roleList = roleName.split(",");\n  if (roleList.length !== 1 || roleList[0] !== roleName) {\n    throw APIError.from("BAD_REQUEST", "INVALID_ROLE_NAME");\n  }\n  return roleName;\n};\n',
      "packages/better-auth/src/plugins/organization/routes/crud-access-control.test.ts":
        'import { test } from "bun:test";\ntest("normalizeRoleName rejects multi-role dynamic names", () => {});\n',
    },
    buggyOverlay: {
      "packages/better-auth/src/plugins/organization/routes/crud-access-control.ts":
        "export const normalizeRoleName = (role: string) => role.toLowerCase();\n",
    },
    targetFile: "packages/better-auth/src/plugins/organization/routes/crud-access-control.ts",
    expectedRootTest: "packages/better-auth/src/plugins/organization/routes/crud-access-control.test.ts",
  },
  {
    name: "MCP-TS-SDK 919bb8e (Post-AI TS): dropping fail-closed paramHeaderMismatchRejection guard",
    goodFiles: {
      "packages/core-internal/src/shared/mcpParamHeaders.ts":
        'export function validateMcpParamHeaders(bodyRaw: unknown, headerValue: string | null) {\n  if (typeof bodyRaw === "object") {\n    return paramHeaderMismatchRejection("param-header-mismatch", "x-param");\n  }\n  return null;\n}\n',
      "packages/core-internal/test/shared/mcpParamHeaders.test.ts":
        'import { test } from "bun:test";\ntest("validateMcpParamHeaders rejects non-primitive object values", () => {});\n',
    },
    buggyOverlay: {
      "packages/core-internal/src/shared/mcpParamHeaders.ts":
        "export function validateMcpParamHeaders(bodyRaw: unknown, headerValue: string | null) {\n  return bodyRaw && headerValue ? null : null;\n}\n",
    },
    targetFile: "packages/core-internal/src/shared/mcpParamHeaders.ts",
    expectedRootTest: "packages/core-internal/test/shared/mcpParamHeaders.test.ts",
  },
  {
    name: "Pydantic-AI de924e7 (Post-AI Python): dropping InvalidOperation from SpendLimits except guard",
    goodFiles: {
      "src/pydantic_ai_harness/pydantic_ai_harness/spend_limits/_capability.py":
        'def _budget_from_spec(value):\n    try:\n        return int(value)\n    except (TypeError, ValueError, InvalidOperation) as error:\n        raise UserError("budget is not a number") from error\n',
      "tests/harness/spend_limits/test_spend.py":
        "def test_budget_from_spec_rejects_non_numeric_usd():\n    assert True\n",
    },
    buggyOverlay: {
      "src/pydantic_ai_harness/pydantic_ai_harness/spend_limits/_capability.py":
        'def _budget_from_spec(value):\n    try:\n        return int(value)\n    except (TypeError, ValueError) as error:\n        raise UserError("budget is not a number") from error\n',
    },
    targetFile: "src/pydantic_ai_harness/pydantic_ai_harness/spend_limits/_capability.py",
    expectedRootTest: "tests/harness/spend_limits/test_spend.py",
  },
  {
    name: "Pydantic-AI ae0968e (Post-AI Python): reverting ValueError guard back to bare assert",
    goodFiles: {
      "pydantic_ai_slim/pydantic_ai/embeddings/result.py":
        'class EmbeddingResult:\n    def cost(self):\n        if not self.model_name:\n            raise ValueError("Model name is required")\n        return 0\n',
      "tests/test_cost.py":
        "def test_embedding_result_cost_requires_model_name():\n    assert True\n",
    },
    buggyOverlay: {
      "pydantic_ai_slim/pydantic_ai/embeddings/result.py":
        'class EmbeddingResult:\n    def cost(self):\n        assert self.model_name, "Model name is required"\n        return 0\n',
    },
    targetFile: "pydantic_ai_slim/pydantic_ai/embeddings/result.py",
    expectedRootTest: "tests/test_cost.py",
  },
];

describe("Deep Pre-AI & Post-AI Titan Evals (Better-Auth, MCP SDK, Pydantic-AI, FastAPI)", () => {
  test.each(DEEP_POST_AI_REGRESSIONS)(
    "catches regression and binds exact root test: $name",
    async ({ goodFiles, buggyOverlay, targetFile, expectedRootTest }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-deep-ci-"));
      try {
        writeTree(dir, goodFiles);
        const host = await createPluginHost({ repoDir: dir });
        try {
          const ext = await host.extract(dir);
          Registry.writeSql(dir, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });
          expect((await host.check(dir, { strictDrift: true })).ok).toBe(true);

          const inv = ext.invariants.find((i) => i.file === targetFile);
          expect(inv).toBeDefined();
          expect(inv?.rootTestPath).toBe(expectedRootTest);

          writeTree(dir, buggyOverlay);
          const regressed = await host.check(dir);
          expect(regressed.ok).toBe(false);
          const hit = regressed.violations.find(
            (v) => v.rule === "invariant-guard-dropped-in-code" && v.file === targetFile,
          );
          expect(hit).toBeDefined();
          expect(hit?.message).toContain(expectedRootTest);
        } finally {
          await host.dispose();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("FastAPI 55ee14b (Pre-AI Python): catches silent whole-feature deletion from code without registry edit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-deep-fa-"));
    try {
      writeTree(dir, {
        "fastapi/applications.py": "class FastAPI:\n    pass\n",
        "fastapi/_body_limit.py":
          'def enforce_body_limit(size: int, max_size: int) -> None:\n    if size > max_size:\n        raise ValueError("body too large")\n',
        "tests/test_request_body_limits.py": "def test_enforce_body_limit():\n    assert True\n",
        "tests/test_applications.py": "def test_fastapi_app():\n    assert True\n",
      });
      const host = await createPluginHost({ repoDir: dir });
      try {
        const ext = await host.extract(dir);
        Registry.writeSql(dir, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });
        expect((await host.check(dir, { strictDrift: true })).ok).toBe(true);

        fs.rmSync(path.join(dir, "fastapi", "_body_limit.py"));
        const afterDelete = await host.check(dir);
        expect(afterDelete.ok).toBe(false);
        expect(afterDelete.violations.some((v) => v.rule === "feature-removed-from-code" && v.featureId === "feat.fastapi-body-limit")).toBe(true);
      } finally {
        await host.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
