import { describe, expect, test } from "bun:test";
import { extractExportedSymbols, extractTestCases, scanFileInvariants, slugifyIdentifier } from "../src/polyglot.ts";

describe("@featlock/plugin-ast-scanner unit contract", () => {
  test("slugifyIdentifier and polyglot extractors handle TS and Rust inputs", () => {
    expect(slugifyIdentifier("Crate:GlobSet!!")).toBe("crate-globset");
    const tsFile = { rel: "src/a.ts", abs: "/src/a.ts", ext: ".ts", isTest: false, content: "export function alpha() {}\n", lines: 1 };
    expect(extractExportedSymbols(tsFile)).toEqual(["alpha"]);
    const rsTest = { rel: "crates/a/lib.rs", abs: "/crates/a/lib.rs", ext: ".rs", isTest: false, content: "#[test]\nfn checks_a() {}\n", lines: 2 };
    expect(extractTestCases(rsTest)[0]?.name).toBe("checks_a");
  });

  test("scanFileInvariants masks comments and string literals across TS, Python, and Rust", () => {
    const tsAdversarial = {
      rel: "src/auth.ts",
      abs: "/src/auth.ts",
      ext: ".ts",
      isTest: false,
      content: [
        "// if (!fakeComment) throw new Error('nope');",
        "/* if (!fakeBlock) throw new Error('nope'); */",
        "export function check(x: string): string {",
        "  const doc = \"if (!fakeString) throw new Error('in string');\";",
        "  if (!x) throw new Error('x required');",
        "  return x + doc;",
        "}",
      ].join("\n"),
      lines: 7,
    };
    const tsInvs = scanFileInvariants(tsAdversarial, "feat.auth");
    expect(tsInvs).toHaveLength(1);
    expect(tsInvs[0]?.line).toBe(5);
    expect(tsInvs[0]?.guardAnchor).toContain("if (!x)");

    const pyAdversarial = {
      rel: "src/auth.py",
      abs: "/src/auth.py",
      ext: ".py",
      isTest: false,
      content: [
        '"""',
        "if not doc_guard:",
        "    raise ValueError('docstring only')",
        '"""',
        "# if not comment_guard: raise ValueError('comment')",
        "def check(x):",
        "    if not x:",
        "        raise ValueError('required')",
      ].join("\n"),
      lines: 8,
    };
    const pyInvs = scanFileInvariants(pyAdversarial, "feat.auth");
    expect(pyInvs).toHaveLength(1);
    expect(pyInvs[0]?.line).toBe(7);

    const rsLifetimes = {
      rel: "src/lib.rs",
      abs: "/src/lib.rs",
      ext: ".rs",
      isTest: false,
      content: [
        "// assert!(fake_comment);",
        "pub fn check<'a>(s: &'a str) {",
        "    let _msg = \"assert!(fake_string);\";",
        "    assert!(!s.is_empty());",
        "}",
        "#[cfg(test)]",
        "mod tests {",
        "    fn t() { assert!(ignored_in_cfg_test); }",
        "}",
      ].join("\n"),
      lines: 9,
    };
    const rsInvs = scanFileInvariants(rsLifetimes, "feat.lib");
    expect(rsInvs).toHaveLength(1);
    expect(rsInvs[0]?.line).toBe(4);

    const goGuards = {
      rel: "pkg/server.go",
      abs: "/pkg/server.go",
      ext: ".go",
      isTest: false,
      content: [
        "func serve(w http.ResponseWriter, bad bool) error {",
        "  if bad {",
        "    http.Error(w, \"bad\", 400)",
        "  }",
        "  if !bad {",
        "    return fmt.Errorf(\"fail\")",
        "  }",
        "  return nil",
        "}",
      ].join("\n"),
      lines: 9,
    };
    const goInvs = scanFileInvariants(goGuards, "feat.server");
    expect(goInvs.map((g) => g.kind)).toEqual(["go-http-guard", "go-error-guard"]);
    expect(goInvs[0]?.confidence).toBeGreaterThan(goInvs[1]?.confidence ?? 0);

    const manyGuards = Array.from({ length: 30 }, (_, idx) => `if (x === ${idx}) throw new Error("e${idx}");`).join("\n");
    const capped = scanFileInvariants(
      { rel: "src/many.ts", abs: "/src/many.ts", ext: ".ts", isTest: false, content: manyGuards, lines: 30 },
      "feat.many",
    );
    expect(capped).toHaveLength(24);
  });
});
