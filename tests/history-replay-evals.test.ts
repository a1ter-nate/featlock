import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost, Registry } from "@featlock/core";

function seedFiles(dir: string, files: Readonly<Record<string, string>>): void {
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, "utf8");
  }
}

interface RegressionEvalCase {
  readonly name: string;
  readonly goodFiles: Readonly<Record<string, string>>;
  readonly buggyOverlay: Readonly<Record<string, string>>;
  readonly targetFile: string;
  readonly expectedRootTest: string;
}

const REGRESSION_EVALS: readonly RegressionEvalCase[] = [
  {
    name: "Hono dd30c11 (TS): dropping basic-auth non-string credential guard",
    goodFiles: {
      "src/middleware/basic-auth/index.ts":
        'export const basicAuth = (users: Array<{ username: unknown; password: unknown }>) => {\n  for (const user of users) {\n    if (typeof user.username !== "string" || typeof user.password !== "string") {\n      throw new Error("basic auth requires strings");\n    }\n  }\n  return users;\n};\n',
      "src/middleware/basic-auth/index.test.ts":
        'import { test } from "bun:test";\ntest("basicAuth throws if username or password is not a string", () => {});\n',
    },
    buggyOverlay: {
      "src/middleware/basic-auth/index.ts":
        "export const basicAuth = (users: Array<{ username: unknown; password: unknown }>) => {\n  return users;\n};\n",
    },
    targetFile: "src/middleware/basic-auth/index.ts",
    expectedRootTest: "src/middleware/basic-auth/index.test.ts",
  },
  {
    name: "Hono 79f23af (TS): weakening SSE retry newline injection guard",
    goodFiles: {
      "src/helper/streaming/sse.ts":
        'export function writeSSE(message: Record<string, unknown>) {\n  for (const key of ["event", "id", "retry"] as const) {\n    const value = message[key];\n    if (value && /[\\r\\n]/.test(String(value))) {\n      throw new Error(`${key} must not contain newline`);\n    }\n  }\n}\n',
      "src/helper/streaming/sse.test.tsx":
        'import { test } from "bun:test";\ntest("writeSSE rejects line breaks in retry", () => {});\n',
    },
    buggyOverlay: {
      "src/helper/streaming/sse.ts":
        'export function writeSSE(message: Record<string, unknown>) {\n  for (const key of ["event", "id"] as const) {\n    const value = message[key];\n    if (value && /[\\r\\n]/.test(value as string)) {\n      throw new Error(`${key} must not contain newline`);\n    }\n  }\n}\n',
    },
    targetFile: "src/helper/streaming/sse.ts",
    expectedRootTest: "src/helper/streaming/sse.test.tsx",
  },
  {
    name: "HTTPX ce7e14d (Python): dropping verify-as-str RuntimeError guard",
    goodFiles: {
      "httpx/_config.py":
        'def create_ssl_context(verify):\n    if verify is False:\n        return None\n    elif isinstance(verify, str):\n        msg = "verify should be a boolean or SSLContext"\n        raise RuntimeError(msg)\n    return verify\n',
      "tests/test_config.py":
        "def test_create_ssl_context_verify_str():\n    assert True\n",
    },
    buggyOverlay: {
      "httpx/_config.py":
        "def create_ssl_context(verify):\n    if verify is False:\n        return None\n    return verify\n",
    },
    targetFile: "httpx/_config.py",
    expectedRootTest: "tests/test_config.py",
  },
  {
    name: "Caddy 13ae345 (Go): dropping opaque HTTP request target rejection guard",
    goodFiles: {
      "modules/caddyhttp/server.go":
        'package caddyhttp\nfunc (s *Server) ServeHTTP(w ResponseWriter, r *Request) {\n\tif r.URL.Opaque != "" {\n\t\thttp.Error(w, "invalid request target", http.StatusBadRequest)\n\t\treturn\n\t}\n}\n',
      "modules/caddyhttp/server_request_target_test.go":
        "package caddyhttp\nfunc TestServeHTTPRejectsOpaqueTarget() {}\n",
    },
    buggyOverlay: {
      "modules/caddyhttp/server.go":
        "package caddyhttp\nfunc (s *Server) ServeHTTP(w ResponseWriter, r *Request) {\n}\n",
    },
    targetFile: "modules/caddyhttp/server.go",
    expectedRootTest: "modules/caddyhttp/server_request_target_test.go",
  },
  {
    name: "Polly f2a07e6 (C#): dropping Guard.NotNull(monitor) on EnableReloadsWithMonitor",
    goodFiles: {
      "src/Polly.Extensions/DependencyInjection/AddResiliencePipelineContext.cs":
        "public sealed class AddResiliencePipelineContext {\n  public void EnableReloadsWithMonitor(object monitor) {\n    Guard.NotNull(monitor);\n  }\n}\n",
      "test/Polly.Extensions.Tests/DependencyInjection/ReloadableResiliencePipelineTests.cs":
        "public class ReloadableResiliencePipelineTests {\n  [Fact]\n  public void EnableReloadsWithMonitor_ThrowsOnNull() {}\n}\n",
      "test/Polly.Extensions.Tests/Issues/IssuesTests.cs":
        "public class IssuesTests {\n  [Fact]\n  public void UnrelatedPipelineIssue() {}\n}\n",
    },
    buggyOverlay: {
      "src/Polly.Extensions/DependencyInjection/AddResiliencePipelineContext.cs":
        "public sealed class AddResiliencePipelineContext {\n  public void EnableReloadsWithMonitor(object monitor) {}\n}\n",
    },
    targetFile: "src/Polly.Extensions/DependencyInjection/AddResiliencePipelineContext.cs",
    expectedRootTest: "test/Polly.Extensions.Tests/DependencyInjection/ReloadableResiliencePipelineTests.cs",
  },
];

describe("OSS Titan Git-History Replay Evals: Regressions, New Feature Saves & Root Test Mapping", () => {
  test.each(REGRESSION_EVALS)(
    "catches dropped invariant and binds exact root test: $name",
    async ({ goodFiles, buggyOverlay, targetFile, expectedRootTest }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-eval-reg-"));
      try {
        seedFiles(dir, goodFiles);
        const host = await createPluginHost({ repoDir: dir });
        try {
          const ext = await host.extract(dir);
          Registry.writeSql(dir, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });
          const baseline = await host.check(dir, { strictDrift: true });
          expect(baseline.ok).toBe(true);

          const inv = ext.invariants.find((i) => i.file === targetFile);
          expect(inv).toBeDefined();
          expect(inv?.rootTestPath).toBe(expectedRootTest);

          seedFiles(dir, buggyOverlay);
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

  test("catches unrecorded new feature, new invariant, and new capability test, then passes strictDrift after save", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-eval-add-"));
    try {
      seedFiles(dir, {
        "src/middleware/basic-auth/index.ts": "export const basicAuth = () => true;\n",
        "src/middleware/basic-auth/index.test.ts": 'import { test } from "bun:test";\ntest("basicAuth works", () => {});\n',
        "crates/searcher/src/lib.rs": "pub struct Searcher;\n#[cfg(test)]\nmod t { #[test] fn ok() {} }\n",
      });
      const host = await createPluginHost({ repoDir: dir });
      try {
        const initial = await host.extract(dir);
        Registry.writeSql(dir, { features: initial.features, tests: initial.tests, invariants: initial.invariants, auditLog: [] });
        expect((await host.check(dir, { strictDrift: true })).ok).toBe(true);

        seedFiles(dir, {
          "src/middleware/mount/index.ts":
            'export function mount(prefix: string) {\n  if (!prefix.startsWith("/")) {\n    throw new Error("prefix must start with /");\n  }\n  return prefix;\n}\n',
          "src/middleware/mount/index.test.ts":
            'import { test } from "bun:test";\ntest("mount validates prefix", () => {});\n',
          "crates/searcher/src/lib.rs":
            "pub struct Searcher;\npub fn max_bytes(n: u64) -> u64 { n }\n#[cfg(test)]\nmod t { #[test] fn ok() {} }\n",
          "tests/max_bytes.rs": "#[test]\nfn enforces_max_bytes() {}\n",
        });

        const beforeSave = await host.check(dir, { strictDrift: true });
        expect(beforeSave.ok).toBe(false);
        expect(beforeSave.violations.some((v) => v.rule === "unrecorded-new-feature" && v.featureId === "feat.middleware-mount")).toBe(true);
        expect(beforeSave.violations.some((v) => v.rule === "unrecorded-new-invariant" && v.file === "src/middleware/mount/index.ts")).toBe(true);
        expect(beforeSave.violations.some((v) => v.rule === "unrecorded-new-feature-test" && v.file === "tests/max_bytes.rs")).toBe(true);

        const saved = await host.extract(dir);
        Registry.writeSql(dir, { features: saved.features, tests: saved.tests, invariants: saved.invariants, auditLog: [] });
        const afterSave = await host.check(dir, { strictDrift: true });
        expect(afterSave.ok).toBe(true);
        expect(saved.invariants.find((i) => i.file === "src/middleware/mount/index.ts")?.rootTestPath).toBe("src/middleware/mount/index.test.ts");
      } finally {
        await host.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("benign line-number shifts produce zero false positives under strictDrift", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-eval-ctrl-"));
    try {
      const orig = 'export function guard(x: number) {\n  if (x <= 0) {\n    throw new Error("positive only");\n  }\n  return x;\n}\n';
      seedFiles(dir, {
        "src/billing/charge.ts": orig,
        "src/billing/charge.test.ts": 'import { test } from "bun:test";\ntest("guard rejects non-positive", () => {});\n',
      });
      const host = await createPluginHost({ repoDir: dir });
      try {
        const ext = await host.extract(dir);
        Registry.writeSql(dir, { features: ext.features, tests: ext.tests, invariants: ext.invariants, auditLog: [] });
        seedFiles(dir, { "src/billing/charge.ts": `\n\nexport const VERSION = 2;\n\n${orig}` });
        const afterShift = await host.check(dir, { strictDrift: true });
        expect(afterShift.ok).toBe(true);
        expect(afterShift.violations.length).toBe(0);
      } finally {
        await host.dispose();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
