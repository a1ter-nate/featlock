import { describe, expect, test } from "bun:test";
import { anonymizeSnippet, buildIssueUrl, redactText } from "../packages/plugins/registry-cli/src/report.ts";

describe("@featlock/plugin-registry-cli pure report helpers", () => {
  test("scrubs credentials and paths deterministically without touching disk", () => {
    const out = redactText("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig1234567890 ops@example.org", "/tmp/work");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).not.toContain("ops@example.org");
    expect(out).toContain("<redacted-email>");
  });

  test("anonymizeSnippet and buildIssueUrl stay bounded and deterministic", () => {
    expect(anonymizeSnippet('if (!tenantKey) throw new Error("nope");')).toContain('id1');
    const url = buildIssueUrl({ kind: "fp", title: "[FP] sample", body: "minimal repro" });
    expect(url.truncated).toBe(false);
    expect(url.url).toContain("template=false-positive.yml");
  });
});
