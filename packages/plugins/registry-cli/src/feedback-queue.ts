import fs from "node:fs";
import path from "node:path";
import type { ReportKind, ReportPayload } from "./report.ts";

export const FEEDBACK_QUEUE_REL = ".verification/tool-feedback.jsonl";

export interface QueuedFeedbackEntry {
  readonly tool: string;
  readonly runtime: string;
  readonly platform: string;
  readonly kind: ReportKind;
  readonly rule: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly language: string;
  readonly reason: string;
  readonly anonymized: boolean;
  readonly snippet: string | null;
}

export interface FlushedFeedbackGroup {
  readonly kind: ReportKind;
  readonly rule: string;
  readonly count: number;
  readonly samples: readonly QueuedFeedbackEntry[];
}

export interface FlushedRollup {
  readonly queuePath: string;
  readonly totalEntries: number;
  readonly groups: readonly FlushedFeedbackGroup[];
  readonly title: string;
  readonly markdown: string;
}

export function appendFeedbackEntry(
  repoRoot: string,
  payload: ReportPayload,
): { readonly queuePath: string; readonly count: number } {
  if (!repoRoot) throw new Error("repoRoot is required to queue local feedback.");
  const queuePath = path.join(repoRoot, FEEDBACK_QUEUE_REL);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  const entry: QueuedFeedbackEntry = {
    tool: payload.tool,
    runtime: payload.runtime,
    platform: payload.platform,
    kind: payload.kind,
    rule: payload.rule,
    file: payload.file,
    line: payload.line,
    language: payload.language,
    reason: payload.reason,
    anonymized: payload.anonymized,
    snippet: payload.snippet,
  };
  fs.appendFileSync(queuePath, `${JSON.stringify(entry)}\n`, "utf8");
  const lines = fs.readFileSync(queuePath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
  return { queuePath, count: lines.length };
}

function readQueuedEntries(queuePath: string): QueuedFeedbackEntry[] {
  if (!queuePath) throw new Error("queuePath is required.");
  if (!fs.existsSync(queuePath)) return [];
  const entries: QueuedFeedbackEntry[] = [];
  for (const line of fs.readFileSync(queuePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<QueuedFeedbackEntry>;
      if (parsed && typeof parsed.rule === "string") {
        const kind: ReportKind =
          parsed.kind === "fn" || parsed.kind === "crash" || parsed.kind === "bug" ? parsed.kind : "fp";
        entries.push({
          tool: parsed.tool ?? "featlock",
          runtime: parsed.runtime ?? "unknown",
          platform: parsed.platform ?? "unknown",
          kind,
          rule: parsed.rule,
          file: parsed.file ?? null,
          line: typeof parsed.line === "number" ? parsed.line : null,
          language: parsed.language ?? "unknown",
          reason: parsed.reason ?? "",
          anonymized: Boolean(parsed.anonymized),
          snippet: parsed.snippet ?? null,
        });
      }
    } catch {
      continue;
    }
  }
  return entries;
}

export function buildFlushedRollup(repoRoot: string): FlushedRollup {
  if (!repoRoot) throw new Error("repoRoot is required to flush feedback queue.");
  const queuePath = path.join(repoRoot, FEEDBACK_QUEUE_REL);
  const raw = readQueuedEntries(queuePath);
  const byKey = new Map<string, { kind: ReportKind; rule: string; count: number; seenSamples: Set<string>; samples: QueuedFeedbackEntry[] }>();

  for (const item of raw) {
    const key = `${item.kind}|${item.rule}`;
    const bucket = byKey.get(key) ?? { kind: item.kind, rule: item.rule, count: 0, seenSamples: new Set<string>(), samples: [] };
    bucket.count += 1;
    const sampleKey = `${item.file ?? ""}:${item.line ?? 0}|${item.reason}`;
    if (!bucket.seenSamples.has(sampleKey) && bucket.samples.length < 3) {
      bucket.seenSamples.add(sampleKey);
      bucket.samples.push(item);
    }
    byKey.set(key, bucket);
  }

  const groups: FlushedFeedbackGroup[] = [...byKey.values()]
    .map((g) => ({ kind: g.kind, rule: g.rule, count: g.count, samples: g.samples }))
    .toSorted((a, b) => (b.count - a.count) || a.rule.localeCompare(b.rule));

  const title = `[FEEDBACK ROLLUP] ${groups.length} rule group(s) across ${raw.length} queued report(s)`;
  const lines: string[] = [
    `## ${title}`,
    "",
    `- **Queued Entries:** ${raw.length}`,
    `- **Unique Rule Groups:** ${groups.length}`,
    "",
  ];
  for (const grp of groups) {
    lines.push(`### [${grp.kind.toUpperCase()}] \`${grp.rule}\` (${grp.count}x)`);
    for (const s of grp.samples) {
      const loc = s.file ? `${s.file}${s.line ? `:${s.line}` : ""}` : "unspecified";
      lines.push(`- \`${loc}\` (${s.language}): ${s.reason}`);
      if (s.snippet) {
        lines.push(`\`\`\`${s.language === "unknown" ? "" : s.language}`, s.snippet, "```");
      }
    }
    lines.push("");
  }
  return { queuePath, totalEntries: raw.length, groups, title, markdown: `${lines.join("\n").trimEnd()}\n` };
}

export function clearFeedbackQueue(repoRoot: string): boolean {
  if (!repoRoot) return false;
  const queuePath = path.join(repoRoot, FEEDBACK_QUEUE_REL);
  if (!fs.existsSync(queuePath)) return false;
  fs.rmSync(queuePath, { force: true });
  return true;
}
