import { describe, expect, test } from "bun:test";
import { extractExportedSymbols, extractTestCases, slugifyIdentifier } from "../../../packages/plugins/ast-scanner/src/polyglot.ts";

describe("@featlock/plugin-ast-scanner unit contract", () => {
  test("slugifyIdentifier and polyglot extractors handle TS and Rust inputs", () => {
    expect(slugifyIdentifier("Crate:GlobSet!!")).toBe("crate-globset");
    const tsFile = { rel: "src/a.ts", abs: "/src/a.ts", ext: ".ts", isTest: false, content: "export function alpha() {}\n", lines: 1 };
    expect(extractExportedSymbols(tsFile)).toEqual(["alpha"]);
    const rsTest = { rel: "crates/a/lib.rs", abs: "/crates/a/lib.rs", ext: ".rs", isTest: false, content: "#[test]\nfn checks_a() {}\n", lines: 2 };
    expect(extractTestCases(rsTest)[0]?.name).toBe("checks_a");
  });
});
