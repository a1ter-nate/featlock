import type { FeatlockStudioData, GuardViolation } from "@featlock/plugin";

export type ActionTier = "broken" | "fix_next" | "structural" | "holding";

export interface ResearchSource {
  readonly label: string;
  readonly url: string;
}

export interface ActionEvidenceGroup {
  readonly groupLabel: string;
  readonly count: number;
  readonly items: readonly { readonly title: string; readonly location: string; readonly detail: string }[];
}

export interface ActionItem {
  readonly id: string;
  readonly tier: ActionTier;
  readonly title: string;
  readonly subtitle: string;
  readonly count: number;
  readonly what: string;
  readonly why: string;
  readonly fix: string;
  readonly benefit: string;
  readonly cliCommand: string;
  readonly sources: readonly ResearchSource[];
  readonly groups: readonly ActionEvidenceGroup[];
}

export interface ActionQueueModel {
  readonly verdict: string;
  readonly isLivePreview: boolean;
  readonly counts: {
    readonly broken: number;
    readonly fixNext: number;
    readonly structural: number;
    readonly holding: number;
  };
  readonly items: readonly ActionItem[];
  readonly defaultItemId: string | null;
}

export interface GlossaryEntry {
  readonly term: string;
  readonly plainEnglish: string;
  readonly whyItMatters: string;
  readonly source: ResearchSource;
}

const SRC_REISS: ResearchSource = { label: "Reiss (2008) — Tracking Source Locations", url: "https://cs.brown.edu/people/spr/research/env/tracking.html" };
const SRC_CANFORA: ResearchSource = { label: "Canfora & Cerulo (2006) — Bugfix History", url: "https://ieeexplore.ieee.org/document/4021365" };
const SRC_EADDY: ResearchSource = { label: "Eaddy et al. (2008) — Scattering & Defects", url: "https://ieeexplore.ieee.org/document/4488255" };
const SRC_KING: ResearchSource = { label: "Alexis King — Parse, Don't Validate", url: "https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/" };
const SRC_KUHN: ResearchSource = { label: "NIST / Kuhn — Combinatorial Pairwise Testing", url: "https://csrc.nist.gov/projects/automated-combinatorial-testing-for-software" };
const SRC_OUSTERHOUT: ResearchSource = { label: "Ousterhout — A Philosophy of Software Design", url: "https://web.stanford.edu/~ouster/cgi-bin/book.php" };

export const STUDIO_GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: "Feature",
    plainEnglish: "A named product capability (an app, package, or subsystem) tracked alongside the tests and safety rules that keep it working.",
    whyItMatters: "Prevents AI agents or refactors from silently deleting or duplicating capabilities that users rely on.",
    source: SRC_OUSTERHOUT,
  },
  {
    term: "Locked Invariant (Guard)",
    plainEnglish: "A concrete safety rule found in your code — like a validation check, auth guard, or error boundary — tied to its source symbol and root test.",
    whyItMatters: "When someone simplifies code and accidentally drops an edge-case check, FeatLock catches the exact missing rule before merge.",
    source: SRC_REISS,
  },
  {
    term: "Fence Strength (Static vs. Runtime)",
    plainEnglish: "How early a rule is enforced: R0/R1 means the linter or type system makes bugs impossible; R2/R3 means automated tests prove it; Runtime means only an `if/throw` check catches it when live code runs.",
    whyItMatters: "Moving checks from runtime `if` statements up to static types eliminates whole classes of bugs permanently.",
    source: SRC_KING,
  },
  {
    term: "File Scattering (DoS) & Tangling (DoF)",
    plainEnglish: "Scattering counts how many files a single feature is spread across. Tangling counts how many different features share one file.",
    whyItMatters: "Features spread across 8+ files have a huge blast radius — editing or removing them is far more likely to break something nearby.",
    source: SRC_EADDY,
  },
  {
    term: "Bugfix-Origin Guard",
    plainEnglish: "A safety check introduced in a commit whose message says `fix:` or `bugfix` — meaning it exists because of a real past incident.",
    whyItMatters: "Dropping a bugfix-origin guard almost always re-introduces a regression your team already suffered once.",
    source: SRC_CANFORA,
  },
];

function buildViolationItem(rule: string, hits: readonly GuardViolation[], tier: ActionTier): ActionItem {
  if (!rule || hits.length === 0) throw new Error("Non-empty rule and hits are required.");
  const byFile = new Map<string, GuardViolation[]>();
  for (const h of hits) {
    const key = h.file ?? "features/registry.sql";
    const list = byFile.get(key) ?? [];
    list.push(h);
    byFile.set(key, list);
  }
  const groups: ActionEvidenceGroup[] = Array.from(byFile.entries()).map(([file, list]) => ({
    groupLabel: file,
    count: list.length,
    items: list.map((h) => ({ title: h.featureId ?? rule, location: file, detail: h.message })),
  }));
  const first = hits[0];
  return {
    id: `rule:${rule}`,
    tier,
    title: rule.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
    subtitle: `${hits.length} finding(s) across ${groups.length} file(s)`,
    count: hits.length,
    what: first?.message ?? `Rule '${rule}' reported ${hits.length} issue(s).`,
    why: tier === "broken"
      ? "This check blocks merges because an active feature, linked test, or safety guard appears broken or missing."
      : "Unresolved warnings signal hidden regression risk or stale traceability.",
    fix: first?.fix ?? "Inspect each affected file below and restore the missing guard or test link.",
    benefit: "Restores provable protection so future edits and AI agents cannot silently regress this behavior.",
    cliCommand: "featlock check . --strict-drift",
    sources: [SRC_REISS],
    groups,
  };
}

function groupViolationsByRule(violations: readonly GuardViolation[], tier: ActionTier): ActionItem[] {
  const byRule = new Map<string, GuardViolation[]>();
  for (const v of violations) {
    const list = byRule.get(v.rule) ?? [];
    list.push(v);
    byRule.set(v.rule, list);
  }
  return Array.from(byRule.entries()).map(([rule, hits]) => buildViolationItem(rule, hits, tier));
}

function buildLivePreviewInsight(data: FeatlockStudioData): ActionItem {
  const activeFeats = data.registry.features.filter((f) => f.status === "active");
  return {
    id: "insight:lock-registry",
    tier: "fix_next",
    title: "Lock This Live Scan Into Your Repo",
    subtitle: `${data.counts.features} features & ${data.counts.invariants} guards discovered (not locked yet)`,
    count: data.counts.features,
    what: "FeatLock scanned your codebase live in read-only mode because features/registry.sql has not been saved yet.",
    why: "Without a committed registry, AI agents and refactors have no baseline to block accidental deletions or dropped safety checks.",
    fix: "Run the extract command once, commit features/registry.sql, and add `featlock check .` to CI.",
    benefit: "Turns this one-time snapshot into an always-on anti-regression safety net with SQLite delete protection.",
    cliCommand: "featlock extract . --write && featlock check .",
    sources: [SRC_REISS],
    groups: [
      {
        groupLabel: "Ready to lock",
        count: activeFeats.length,
        items: activeFeats.map((f) => ({ title: f.area, location: f.id, detail: f.summary })),
      },
    ],
  };
}

function buildBugfixInsight(data: FeatlockStudioData): ActionItem | null {
  const bugfixInvs = data.registry.invariants.filter((i) => i.status === "active" && i.originKind === "bugfix");
  if (bugfixInvs.length === 0) return null;
  return {
    id: "insight:bugfix-guards",
    tier: "fix_next",
    title: "Protect Past Bug-Fix Guards",
    subtitle: `${bugfixInvs.length} guard(s) traced to bugfix commits`,
    count: bugfixInvs.length,
    what: `${bugfixInvs.length} safety check(s) in this codebase were added to fix real past bugs.`,
    why: "Bugfix-origin guards represent proven failure modes. If someone simplifies these functions without noticing why the check exists, the original outage comes back.",
    fix: "Verify each guard has a dedicated root regression test and keep its anchor locked (or promote it into a static type boundary).",
    benefit: "Guarantees past production bugs stay permanently fixed even across major refactors.",
    cliCommand: "featlock affected-tests HEAD~1..HEAD",
    sources: [SRC_CANFORA],
    groups: [
      {
        groupLabel: "Bugfix-origin guards",
        count: bugfixInvs.length,
        items: bugfixInvs.map((i) => ({
          title: i.featureId,
          location: `${i.file}:${i.line}`,
          detail: i.statement.replace(/^Precondition fail-closed guard:\s*/, ""),
        })),
      },
    ],
  };
}

function buildUnguardedInsight(data: FeatlockStudioData): ActionItem | null {
  const invCountByFeat = new Map<string, number>();
  for (const inv of data.registry.invariants) {
    if (inv.status === "active") invCountByFeat.set(inv.featureId, (invCountByFeat.get(inv.featureId) ?? 0) + 1);
  }
  const unguarded = data.registry.features.filter((f) => f.status === "active" && (invCountByFeat.get(f.id) ?? 0) === 0);
  if (unguarded.length === 0) return null;
  return {
    id: "insight:unguarded-features",
    tier: "fix_next",
    title: "Areas With Zero Locked Safety Rules",
    subtitle: `${unguarded.length} active area(s) have no extracted guards yet`,
    count: unguarded.length,
    what: `${unguarded.length} area(s) have source code and tests, but zero explicit fail-closed safety guards detected automatically.`,
    why: "Features without explicit invariants can silently change behavior in ways basic unit tests miss.",
    fix: "Run `featlock agent-pass . --json` to mine domain invariants or add boundary validation guards where external data enters.",
    benefit: "Closes blind spots so every critical capability has explicit, regression-proof boundaries.",
    cliCommand: "featlock agent-pass . --json",
    sources: [SRC_KING],
    groups: [
      {
        groupLabel: "Areas without guards",
        count: unguarded.length,
        items: unguarded.map((f) => ({ title: f.area, location: f.id, detail: f.summary })),
      },
    ],
  };
}

function buildPairwiseInsight(data: FeatlockStudioData): ActionItem | null {
  const gaps = data.matrix.interactions.filter((i) => i.pairwiseGap);
  if (gaps.length === 0) return null;
  return {
    id: "insight:pairwise-gaps",
    tier: "fix_next",
    title: "Shared-File Feature Interaction Blind Spots",
    subtitle: `${gaps.length} feature pair(s) share code with no joint test`,
    count: gaps.length,
    what: `${gaps.length} pair(s) of features touch the same files, yet no single test exercises both together.`,
    why: "Most real bugs occur when two features interact (t=2 combinations). Testing them only in isolation hides cross-feature breakage.",
    fix: "Add one integration test covering each high-risk pair or decouple the shared file.",
    benefit: "Catches interaction bugs before users hit them in production.",
    cliCommand: "featlock matrix",
    sources: [SRC_KUHN],
    groups: [
      {
        groupLabel: "Untested feature pairs",
        count: gaps.length,
        items: gaps.map((p) => ({
          title: `${p.featureA} × ${p.featureB}`,
          location: p.sharedVia.slice(0, 2).join(", "),
          detail: `Shared via ${p.sharedVia.length} file(s) with 0 shared tests.`,
        })),
      },
    ],
  };
}

function buildFlagInsight(data: FeatlockStudioData): ActionItem | null {
  const unlinked = data.matrix.flags.filter((f) => f.status !== "linked");
  if (unlinked.length === 0) return null;
  return {
    id: "insight:feature-flags",
    tier: "fix_next",
    title: "Unlinked or Stale Feature Flags",
    subtitle: `${unlinked.length} flag(s) not tied to an active feature`,
    count: unlinked.length,
    what: `${unlinked.length} feature flag(s) in code are either constant/dead or not linked to any tracked feature.`,
    why: "Orphaned flags leave dead branches in production and confuse engineers and AI agents about which code path actually runs.",
    fix: "Delete constant flags or link active rollout flags to their owning feature.",
    benefit: "Shrinks dead code and clarifies which behavior is live.",
    cliCommand: "featlock matrix --json",
    sources: [SRC_OUSTERHOUT],
    groups: [
      {
        groupLabel: "Unlinked / constant flags",
        count: unlinked.length,
        items: unlinked.map((fl) => ({ title: fl.flag, location: `${fl.file}:${fl.line}`, detail: `Status: ${fl.status}` })),
      },
    ],
  };
}

function buildScatteringInsight(data: FeatlockStudioData): ActionItem | null {
  const scattered = data.matrix.scattering.highScattering;
  if (scattered.length === 0) return null;
  return {
    id: "insight:high-scattering",
    tier: "structural",
    title: "Wide Blast-Radius Areas (High File Scattering)",
    subtitle: `${scattered.length} area(s) spread across 8+ source files`,
    count: scattered.length,
    what: `${scattered.length} feature area(s) have guards spread across 8 or more files (up to ${scattered[0]?.files ?? 0} files).`,
    why: "When one capability is scattered across dozens of files, any change has a wide blast radius and is hard for humans or AI agents to reason about or delete cleanly.",
    fix: "Split broad app-level buckets into cohesive domain sub-features (e.g. billing, auth, sync) or consolidate shared boundaries into deep modules.",
    benefit: "Makes every feature cartridge-like — faster to understand, safer to change, and easier to test in isolation.",
    cliCommand: "featlock matrix",
    sources: [SRC_EADDY, SRC_OUSTERHOUT],
    groups: [
      {
        groupLabel: "Scattered areas (8+ files)",
        count: scattered.length,
        items: scattered.map((s) => ({ title: s.featureId, location: `${s.files} files`, detail: `Guards and logic touch ${s.files} distinct files.` })),
      },
    ],
  };
}

function buildRuntimeFenceInsight(data: FeatlockStudioData): ActionItem | null {
  if (!Array.isArray(data.registry.invariants)) throw new Error("invariants array is required.");
  const runtimeOnly = data.registry.invariants.filter((i) => i.status === "active" && (i.fenceRung ?? "none") === "runtime");
  if (runtimeOnly.length === 0) return null;
  const byFeat = new Map<string, typeof runtimeOnly>();
  for (const inv of runtimeOnly) {
    const list = byFeat.get(inv.featureId) ?? [];
    list.push(inv);
    byFeat.set(inv.featureId, list);
  }
  const groups: ActionEvidenceGroup[] = Array.from(byFeat.entries())
    .toSorted((a, b) => b[1].length - a[1].length)
    .map(([fid, list]) => ({
      groupLabel: fid,
      count: list.length,
      items: list.map((inv) => ({
        title: inv.enclosingSymbol ?? inv.kind,
        location: `${inv.file}:${inv.line}`,
        detail: inv.statement.replace(/^Precondition fail-closed guard:\s*/, ""),
      })),
    }));
  return {
    id: "insight:promote-runtime-fences",
    tier: "structural",
    title: "Runtime-Only Checks Ready for Stronger Static Fences",
    subtitle: `${runtimeOnly.length} guard(s) enforced only at runtime across ${groups.length} area(s)`,
    count: runtimeOnly.length,
    what: `${runtimeOnly.length} locked safety checks currently rely on runtime \`if / throw\` guards instead of compile-time types or lint rules.`,
    why: "Runtime guards only catch invalid data after code runs. Parsing invalid inputs once into branded/validated types prevents invalid states from ever being constructed.",
    fix: "When refactoring hot boundaries into stronger static types (R1) or lints (R0), keep root tests green and record the promotion with `featlock supersede`.",
    benefit: "Deletes defensive boilerplate while making safety guarantees strictly stronger — caught at compile time instead of in production.",
    cliCommand: "featlock supersede --id <invariant-id> --by type-boundary --rung R1",
    sources: [SRC_KING],
    groups,
  };
}

function buildDiagnosticInsights(data: FeatlockStudioData, isLivePreview: boolean): ActionItem[] {
  const candidates: Array<ActionItem | null> = [
    isLivePreview ? buildLivePreviewInsight(data) : null,
    buildBugfixInsight(data),
    buildUnguardedInsight(data),
    buildPairwiseInsight(data),
    buildFlagInsight(data),
    buildScatteringInsight(data),
    buildRuntimeFenceInsight(data),
  ];
  return candidates.filter((item): item is ActionItem => item !== null);
}

export function buildActionModel(data: FeatlockStudioData): ActionQueueModel {
  if (!data || !data.registry) throw new Error("FeatlockStudioData is required.");
  const isLivePreview =
    data.counts.features > 0 &&
    (data.check.counts.features === 0 || data.check.warnings.some((w) => w.rule === "registry-empty"));
  const filteredWarnings = isLivePreview
    ? data.check.warnings.filter((w) => w.rule !== "registry-empty" && w.rule !== "feature-high-scattering")
    : data.check.warnings.filter((w) => w.rule !== "feature-high-scattering");
  const brokenItems = groupViolationsByRule(data.check.violations, "broken");
  const warnItems = groupViolationsByRule(filteredWarnings, "fix_next");
  const insights = buildDiagnosticInsights(data, isLivePreview);
  const all = [...brokenItems, ...warnItems, ...insights];

  const counts = {
    broken: all.filter((i) => i.tier === "broken").length,
    fixNext: all.filter((i) => i.tier === "fix_next").length,
    structural: all.filter((i) => i.tier === "structural").length,
    holding: data.registry.features.filter((f) => f.status === "active").length,
  };

  let verdict = `All ${counts.holding} active features are protected with ${data.counts.invariants} locked guards and zero blocking issues.`;
  if (counts.broken > 0) {
    verdict = `${counts.broken} blocking issue(s) need attention before merging — start with Broken items below.`;
  } else if (isLivePreview) {
    verdict = `Live scan found ${data.counts.features} features, ${data.counts.tests} tests, and ${data.counts.invariants} guards — lock them in with one command.`;
  } else if (counts.fixNext > 0) {
    verdict = `Zero blockers. ${counts.fixNext} high-leverage protection improvement(s) ready to review next.`;
  }

  return {
    verdict,
    isLivePreview,
    counts,
    items: all,
    defaultItemId: all[0]?.id ?? null,
  };
}
