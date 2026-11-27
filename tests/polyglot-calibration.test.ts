import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginHost } from "@featlock/core";

interface PolyglotCase {
  readonly lang: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expectedFeatureId: string;
  readonly expectedSymbol: string;
  readonly expectedInvKind: string;
  readonly expectedTestPattern?: string;
  readonly expectedExtraInvKind?: string;
}

const POLYGLOT_CASES: readonly PolyglotCase[] = [
  {
    lang: "TypeScript (multiline guard)",
    files: {
      "src/router/trie.ts": 'export class TrieRouter {\n  match(p: string) {\n    if (!p) {\n      throw new Error("empty path");\n    }\n    return p;\n  }\n}\n',
      "tests/router.test.ts": 'import { test } from "bun:test";\ntest("TrieRouter matches path", () => {});\n',
      "bench/router.ts": 'export const benchRun = () => 1;\n',
    },
    expectedFeatureId: "feat.router",
    expectedSymbol: "TrieRouter",
    expectedInvKind: "precondition-guard",
  },
  {
    lang: "Rust (crate + inline cfg(test) + assert!)",
    files: {
      "crates/matcher/src/lib.rs":
        'pub struct LineMatcher;\npub fn find_match(len: usize) -> usize {\n  assert!(len > 0);\n  len\n}\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn finds_match() {}\n}\n',
      "fuzz/fuzz_targets/target.rs": "pub fn fuzz_entry() {}\n",
    },
    expectedFeatureId: "feat.crate-matcher",
    expectedSymbol: "LineMatcher",
    expectedInvKind: "rust-assert-guard",
  },
  {
    lang: "Python (module + raise guard + pytest)",
    files: {
      "httpx/_auth.py":
        'class BasicAuth:\n    def build(self, token: str) -> str:\n        if not token:\n            raise ValueError("token required")\n        return token\n',
      "tests/test_auth.py": "def test_basic_auth():\n    assert True\n",
    },
    expectedFeatureId: "feat.httpx-auth",
    expectedSymbol: "BasicAuth",
    expectedInvKind: "precondition-guard",
  },
  {
    lang: "Go (module + fmt.Errorf guard + go test)",
    files: {
      "modules/caddyhttp/server.go":
        'package caddyhttp\nimport "fmt"\ntype Server struct{}\nfunc ValidatePort(p int) error {\n\tif p <= 0 {\n\t\treturn fmt.Errorf("invalid port %d", p)\n\t}\n\treturn nil\n}\n',
      "modules/caddyhttp/server_test.go": "package caddyhttp\nfunc TestValidatePort() {}\n",
    },
    expectedFeatureId: "feat.module-caddyhttp",
    expectedSymbol: "Server",
    expectedInvKind: "go-error-guard",
  },
  {
    lang: "C# (project + ThrowIfNull + throw guard + xUnit Fact)",
    files: {
      "src/Polly.Core/RetryStrategy.cs":
        "public sealed class RetryStrategy {\n  public void Execute(object arg, int count) {\n    ArgumentNullException.ThrowIfNull(arg);\n    if (count <= 0)\n      throw new ArgumentOutOfRangeException(nameof(count));\n  }\n}\n",
      "test/Polly.Core.Tests/RetryStrategyTests.cs":
        "public class RetryStrategyTests {\n  [Fact]\n  public void Execute_Works() {}\n}\n",
      "src/Snippets/Example.cs": "public class SnippetDemo {}\n",
    },
    expectedFeatureId: "feat.polly-core",
    expectedSymbol: "RetryStrategy",
    expectedInvKind: "csharp-guard-clause",
    expectedTestPattern: "Execute_Works",
    expectedExtraInvKind: "precondition-guard",
  },
];

describe("Polyglot OSS Titan Calibration Matrix", () => {
  test.each(POLYGLOT_CASES)(
    "extracts feature, exported symbol, linked test, and invariant for $lang while excluding non-prod noise",
    async ({ files, expectedFeatureId, expectedSymbol, expectedInvKind, expectedTestPattern, expectedExtraInvKind }) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "featlock-poly-"));
      try {
        for (const [rel, body] of Object.entries(files)) {
          const abs = path.join(dir, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, body, "utf8");
        }
        const host = await createPluginHost({ repoDir: dir });
        try {
          const out = await host.extract(dir);
          const feat = out.features.find((f) => f.id === expectedFeatureId);
          expect(feat).toBeDefined();
          expect(feat?.summary).toContain(expectedSymbol);
          const linked = out.tests.find((t) => t.featureId === expectedFeatureId);
          expect(linked).toBeDefined();
          const patternMatch = expectedTestPattern ? linked?.testPattern === expectedTestPattern : true;
          expect(patternMatch).toBe(true);
          expect(out.invariants.some((i) => i.featureId === expectedFeatureId && i.kind === expectedInvKind)).toBe(true);
          const extraInvMatch = expectedExtraInvKind
            ? out.invariants.some((i) => i.featureId === expectedFeatureId && i.kind === expectedExtraInvKind)
            : true;
          expect(extraInvMatch).toBe(true);
          expect(out.features.some((f) => /bench|fuzz|snippets/i.test(f.id))).toBe(false);
        } finally {
          await host.dispose();
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
