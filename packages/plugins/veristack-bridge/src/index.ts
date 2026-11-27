import fs from "node:fs";
import path from "node:path";
import {
  Plugin,
  type InvariantRecord,
  type ScanContext,
} from "@featlock/plugin";

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function scanControlPlan(repoRoot: string): InvariantRecord[] {
  if (!repoRoot) throw new Error("repoRoot is required.");
  const planPath = path.join(repoRoot, ".verification", "control-plan.json");
  if (!fs.existsSync(planPath)) return [];
  const raw = JSON.parse(fs.readFileSync(planPath, "utf8")) as {
    controls?: Array<{
      id?: string;
      seam?: string;
      failureMode?: string;
      controlRef?: string;
      reqId?: string;
    }>;
  };
  const out: InvariantRecord[] = [];
  for (const c of raw.controls ?? []) {
    if (!c.id) continue;
    out.push({
      id: `inv:veristack:cp:${slugify(c.id)}`,
      featureId: `feat.${slugify(c.seam ?? c.id)}`,
      kind: "veristack-control-plan",
      statement: `${c.seam ?? c.id}: prevent ${c.failureMode ?? "regression"}`,
      file: c.controlRef ?? ".verification/control-plan.json",
      line: 1,
      confidence: 0.98,
      source: "veristack",
      guardRef: c.reqId ?? c.id,
      status: "active",
    });
  }
  return out;
}

function scanLawsFiles(repoRoot: string): InvariantRecord[] {
  const lawsDir = path.join(repoRoot, ".verification", "laws");
  if (!fs.existsSync(lawsDir)) return [];
  const out: InvariantRecord[] = [];
  for (const entry of fs.readdirSync(lawsDir).filter((f) => f.endsWith(".laws.json")).toSorted()) {
    const abs = path.join(lawsDir, entry);
    const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as {
      laws?: Array<{ id?: string; name?: string; statement?: string; description?: string; witness?: string }>;
    };
    for (const law of raw.laws ?? []) {
      if (!law.id) continue;
      out.push({
        id: `inv:veristack:law:${slugify(law.id)}`,
        featureId: "feat.veristack-laws",
        kind: "veristack-formal-law",
        statement: law.statement ?? law.description ?? law.name ?? law.id,
        file: `.verification/laws/${entry}`,
        line: 1,
        confidence: 0.99,
        source: "veristack",
        guardRef: law.witness ?? law.id,
        status: "active",
      });
    }
  }
  return out;
}

function scanRungManifest(repoRoot: string): InvariantRecord[] {
  const rungsPath = path.join(repoRoot, ".verification", "rungs.json");
  if (!fs.existsSync(rungsPath)) return [];
  const raw = JSON.parse(fs.readFileSync(rungsPath, "utf8")) as {
    rungs?: Record<string, { command?: string; required?: boolean }>;
  };
  const out: InvariantRecord[] = [];
  for (const [rungId, entry] of Object.entries(raw.rungs ?? {})) {
    if (!entry?.command) continue;
    out.push({
      id: `inv:veristack:rung:${slugify(rungId)}`,
      featureId: "feat.verification-ladder",
      kind: "veristack-rung-gate",
      statement: `Verification rung ${rungId} remains wired and passing (${entry.command}).`,
      file: ".verification/rungs.json",
      line: 1,
      confidence: 0.97,
      source: "veristack",
      guardRef: rungId,
      status: "active",
    });
  }
  return out;
}

function scanVeristackArtifacts(ctx: ScanContext): readonly InvariantRecord[] {
  return [
    ...scanControlPlan(ctx.repoRoot),
    ...scanLawsFiles(ctx.repoRoot),
    ...scanRungManifest(ctx.repoRoot),
  ];
}

export default Plugin.define({
  id: "featlock.veristack-bridge",
  async setup(ctx) {
    await ctx.invariantScanner.transform((ed) => {
      ed.add({
        id: "featlock.veristack-bridge.invariants",
        source: "veristack",
        scan: scanVeristackArtifacts,
      });
    });
  },
});
