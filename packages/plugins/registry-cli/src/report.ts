import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandRunContext, RegistrySnapshot } from "@featlock/plugin";
import { appendFeedbackEntry, buildFlushedRollup, clearFeedbackQueue, FEEDBACK_QUEUE_REL } from "./feedback-queue.ts";

export type ReportKind = "fp" | "fn" | "crash" | "bug";

export interface ReportPayload {
  readonly tool: string;
  readonly runtime: string;
  readonly platform: string;
  readonly kind: ReportKind;
  readonly rule: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly language: string;
  readonly command: string | null;
  readonly reason: string;
  readonly anonymized: boolean;
  readonly invariantMeta: { readonly id: string; readonly kind: string; readonly fenceRung: string; readonly guardAnchor: string } | null;
  readonly snippet: string | null;
  readonly title: string;
  readonly markdown: string;
  readonly url: string;
  readonly urlTruncated: boolean;
}

export interface BuildReportInput {
  readonly repoRoot: string;
  readonly args: readonly string[];
  readonly registry: RegistrySnapshot;
}

const ISSUE_REPO = "a1ter-nate/featlock";
const MAX_ISSUE_URL_LEN = 7400;

const CODE_KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default", "elif",
  "else", "enum", "Error", "except", "export", "extends", "false", "finally", "fn", "for", "from", "func",
  "function", "if", "implements", "import", "in", "interface", "is", "let", "match", "new", "nil", "None",
  "not", "null", "number", "or", "package", "private", "protected", "pub", "public", "raise", "readonly",
  "record", "return", "static", "string", "struct", "switch", "this", "throw", "trait", "true", "try",
  "type", "typeof", "undefined", "using", "var", "void", "while", "yield", "boolean", "int", "str", "err",
]);

function parseFlag(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const cur = args[i] ?? "";
    if (cur === flag) return args[i + 1];
    if (cur.startsWith(`${flag}=`)) return cur.slice(flag.length + 1);
  }
  return undefined;
}

function parseKind(raw: string | undefined): ReportKind {
  if (raw === "fn" || raw === "crash" || raw === "bug") return raw;
  return "fp";
}

function inferLanguage(filePath: string | null): string {
  if (!filePath) return "unknown";
  const ext = path.extname(filePath).toLowerCase();
  const map: Readonly<Record<string, string>> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".js": "javascript",
    ".mjs": "javascript",
    ".py": "python",
    ".rs": "rust",
    ".go": "go",
    ".cs": "csharp",
    ".sql": "sql",
  };
  return map[ext] ?? "unknown";
}

function detectToolVersion(): string {
  try {
    const pkgPath = path.resolve(import.meta.dir, "..", "..", "..", "..", "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "featlock" && pkg.version) return `featlock@${pkg.version}`;
    }
  } catch {
    return "featlock@0.1.x";
  }
  return "featlock@0.1.x";
}

export function redactText(text: string, repoRoot?: string): string {
  if (!text) return "";
  let out = text;
  if (repoRoot) {
    const normRoot = path.resolve(repoRoot).replace(/\\/g, "/");
    out = out.replaceAll(normRoot, "<repo>");
    out = out.replaceAll(path.resolve(repoRoot), "<repo>");
  }
  out = out
    .replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s"'`:)]*)?/g, (match) => {
      const parts = match.split("/");
      const tail = parts.slice(4).join("/");
      return tail ? `<repo>/${tail}` : "<home>";
    })
    .replace(/[A-Za-z]:\\Users\\[A-Za-z0-9._-]+(?:\\[^\s"'`:)]*)?/g, (match) => {
      const parts = match.split("\\");
      const tail = parts.slice(4).join("/");
      return tail ? `<repo>/${tail}` : "<home>";
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "<redacted-jwt>")
    .replace(/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|npm|xoxb|xoxp|AIza)[_-]?[A-Za-z0-9_-]{12,}\b/g, "<redacted-secret>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-aws-key>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, "$1<redacted>$3")
    .replace(/(\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*["']?)([^\s"',;)}\]]+)/gi, "$1<redacted>")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<redacted-email>");
  return out;
}

export function anonymizeSnippet(snippet: string): string {
  if (!snippet) return "";
  const idMap = new Map<string, string>();
  let nextId = 1;
  const maskedStrings = snippet.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, '"<str>"');
  return maskedStrings.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (word) => {
    if (CODE_KEYWORDS.has(word) || word === "str") return word;
    const hit = idMap.get(word);
    if (hit) return hit;
    const placeholder = `id${nextId}`;
    nextId += 1;
    idMap.set(word, placeholder);
    return placeholder;
  });
}

function parseFileSpec(raw: string | undefined): { readonly filePath: string | null; readonly line: number | null } {
  if (!raw) return { filePath: null, line: null };
  const match = /^(.*):(\d+)$/.exec(raw);
  if (match?.[1] && match[2]) {
    const parsedLine = Number(match[2]);
    return { filePath: match[1], line: Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine : null };
  }
  return { filePath: raw, line: null };
}

function readSnippetWindow(repoRoot: string, filePath: string | null, line: number | null): string | null {
  if (!filePath) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const center = line ? Math.min(Math.max(1, line), lines.length) : 1;
  const start = Math.max(1, center - 8);
  const end = Math.min(lines.length, center + 8);
  const out: string[] = [];
  for (let ln = start; ln <= end; ln += 1) {
    out.push(`${String(ln).padStart(4, " ")} | ${lines[ln - 1] ?? ""}`);
  }
  return out.join("\n");
}

function findInvariantMeta(
  registry: RegistrySnapshot,
  relFile: string | null,
  line: number | null,
  repoRoot: string,
): ReportPayload["invariantMeta"] {
  if (!relFile) return null;
  const norm = relFile.replace(/\\/g, "/");
  const match = registry.invariants.find((i) => i.file === norm && (!line || Math.abs(i.line - line) <= 8))
    ?? registry.invariants.find((i) => i.file === norm);
  if (!match) return null;
  return {
    id: match.id,
    kind: match.kind,
    fenceRung: match.fenceRung ?? "runtime",
    guardAnchor: redactText(match.guardAnchor ?? "", repoRoot),
  };
}

export function buildIssueUrl(input: {
  readonly kind: ReportKind;
  readonly title: string;
  readonly body: string;
}): { readonly url: string; readonly truncated: boolean } {
  if (!input.title) throw new Error("Issue title is required.");
  const template = input.kind === "fp" ? "false-positive.yml" : "bug-report.yml";
  const label = input.kind === "fp" ? "false-positive" : "bug";
  const base = `https://github.com/${ISSUE_REPO}/issues/new?template=${encodeURIComponent(template)}&labels=${encodeURIComponent(label)}&title=${encodeURIComponent(input.title)}&body=`;
  const encodedBody = encodeURIComponent(input.body);
  if (base.length + encodedBody.length <= MAX_ISSUE_URL_LEN) {
    return { url: `${base}${encodedBody}`, truncated: false };
  }
  const suffix = "\n\n_(Truncated to fit URL length limit — attach full output from `featlock report --out report.md`.)_";
  const budget = Math.max(200, MAX_ISSUE_URL_LEN - base.length - encodeURIComponent(suffix).length);
  let cut = input.body.slice(0, Math.floor(budget / 2));
  while (cut.length > 80 && encodeURIComponent(cut).length > budget) {
    cut = cut.slice(0, Math.floor(cut.length * 0.85));
  }
  return { url: `${base}${encodeURIComponent(`${cut}${suffix}`)}`, truncated: true };
}

function formatMarkdownReport(payload: Omit<ReportPayload, "markdown" | "url" | "urlTruncated">): string {
  if (!payload.title) throw new Error("report payload title is required.");
  const lines: string[] = [
    `## ${payload.title}`,
    "",
    "### Environment",
    `- **Tool:** \`${payload.tool}\``,
    `- **Runtime:** \`${payload.runtime}\``,
    `- **Platform:** \`${payload.platform}\``,
    `- **Kind:** \`${payload.kind}\``,
    `- **Rule / Finding:** \`${payload.rule}\``,
    `- **Language:** \`${payload.language}\``,
  ];
  if (payload.file) lines.push(`- **Target:** \`${payload.file}${payload.line ? `:${payload.line}` : ""}\``);
  if (payload.command) lines.push(`- **Command:** \`${payload.command}\``);
  if (payload.invariantMeta) {
    lines.push(
      `- **Registry Invariant:** \`${payload.invariantMeta.id}\` (kind=\`${payload.invariantMeta.kind}\`, fence=\`${payload.invariantMeta.fenceRung}\`)`,
    );
  }
  lines.push("", "### Why This Looks Wrong / Expected Behavior", payload.reason);
  if (payload.snippet) {
    lines.push(
      "",
      `### Minimal Redacted Snippet${payload.anonymized ? " (Anonymized)" : ""}`,
      `\`\`\`${payload.language === "unknown" ? "" : payload.language}`,
      payload.snippet,
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function buildReportPayload(input: BuildReportInput): ReportPayload {
  if (!input.repoRoot) throw new Error("repoRoot is required to build a report.");
  const rule = parseFlag(input.args, "--rule") ?? parseFlag(input.args, "--finding") ?? "unspecified";
  const kind = parseKind(parseFlag(input.args, "--kind"));
  const { filePath, line } = parseFileSpec(parseFlag(input.args, "--file"));
  const reason = redactText(parseFlag(input.args, "--reason") ?? "Describe why this finding is unexpected.", input.repoRoot);
  const rawCmd = parseFlag(input.args, "--command");
  const command = rawCmd ? redactText(rawCmd, input.repoRoot) : null;
  const anonymized = input.args.includes("--anonymize");

  const relFile = filePath
    ? path.isAbsolute(filePath)
      ? path.relative(input.repoRoot, filePath).split(path.sep).join("/")
      : filePath.split(path.sep).join("/")
    : null;
  const safeFile = relFile ? redactText(relFile, input.repoRoot) : null;
  const rawSnippet = readSnippetWindow(input.repoRoot, filePath, line);
  const redactedSnippet = rawSnippet ? redactText(rawSnippet, input.repoRoot) : null;
  const snippet = redactedSnippet ? (anonymized ? anonymizeSnippet(redactedSnippet) : redactedSnippet) : null;

  const runtime = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`;
  const kindLabel = kind === "fp" ? "FP" : kind.toUpperCase();
  const title = `[${kindLabel}] ${rule}${safeFile ? ` (${path.posix.basename(safeFile)})` : ""}`;
  const base = {
    tool: detectToolVersion(),
    runtime,
    platform: `${os.platform()}/${os.arch()}`,
    kind,
    rule,
    file: safeFile,
    line,
    language: inferLanguage(safeFile),
    command,
    reason,
    anonymized,
    invariantMeta: findInvariantMeta(input.registry, relFile, line, input.repoRoot),
    snippet,
    title,
  };
  const markdown = formatMarkdownReport(base);
  const { url, truncated } = buildIssueUrl({ kind, title, body: markdown });
  return { ...base, markdown, url, urlTruncated: truncated };
}

function submitTextViaGh(
  input: { readonly kind: ReportKind; readonly title: string; readonly body: string },
  ghBin: string,
): { readonly ok: boolean; readonly output: string } {
  const label = input.kind === "fp" ? "false-positive" : "bug";
  const authCheck = spawnSync(ghBin, ["auth", "status"], { encoding: "utf8" });
  if (authCheck.error || authCheck.status !== 0) {
    return { ok: false, output: "gh CLI is unavailable or not authenticated." };
  }
  const createRes = spawnSync(
    ghBin,
    ["issue", "create", "-R", ISSUE_REPO, "--label", label, "--title", input.title, "--body", input.body],
    { encoding: "utf8" },
  );
  if (createRes.error || createRes.status !== 0) {
    const errText = (createRes.stderr || createRes.error?.message || "gh issue create failed").trim();
    return { ok: false, output: errText };
  }
  return { ok: true, output: (createRes.stdout || "").trim() };
}

function runFlushMode(ctx: CommandRunContext): number {
  if (!ctx.repoRoot) throw new Error("CommandRunContext.repoRoot is required.");
  const rollup = buildFlushedRollup(ctx.repoRoot);
  if (rollup.totalEntries === 0) {
    console.log(ctx.asJson ? JSON.stringify({ ...rollup, cleared: false }, null, 2) : `Feedback queue is empty (${FEEDBACK_QUEUE_REL}).`);
    return 0;
  }
  const primaryKind: ReportKind = rollup.groups[0]?.kind ?? "fp";
  const { url, truncated } = buildIssueUrl({ kind: primaryKind, title: rollup.title, body: rollup.markdown });
  const outPath = parseFlag(ctx.args, "--out");
  if (outPath) {
    const absOut = path.isAbsolute(outPath) ? outPath : path.resolve(ctx.repoRoot, outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, rollup.markdown, "utf8");
  }
  const wantSubmit = ctx.args.includes("--submit");
  const wantUrl = ctx.args.includes("--url");
  const wantClear = ctx.args.includes("--clear");
  let submittedUrl: string | null = null;
  let submitFallback: string | null = null;
  if (wantSubmit) {
    const sub = submitTextViaGh({ kind: primaryKind, title: rollup.title, body: rollup.markdown }, process.env.FEATLOCK_GH_BIN ?? "gh");
    if (sub.ok) submittedUrl = sub.output;
    else submitFallback = sub.output;
  }
  const cleared = (submittedUrl !== null || wantClear) ? clearFeedbackQueue(ctx.repoRoot) : false;
  if (ctx.asJson) {
    console.log(JSON.stringify({ ...rollup, url, urlTruncated: truncated, writtenTo: outPath ?? null, submittedUrl, submitFallback, cleared }, null, 2));
    return 0;
  }
  if (wantSubmit) {
    if (submittedUrl) console.log(`Filed roll-up GitHub issue: ${submittedUrl} (queue cleared).`);
    else console.warn(`Could not auto-submit via gh (${submitFallback}). Queue preserved. Open URL:\n${url}`);
    return 0;
  }
  if (wantUrl) {
    console.log(url);
    return 0;
  }
  if (outPath) {
    console.log(`Wrote roll-up report (${rollup.totalEntries} entries, ${rollup.groups.length} group(s)) to ${outPath}${cleared ? " (queue cleared)" : ""}.`);
    return 0;
  }
  console.log(rollup.markdown);
  console.log(`Flush dry-run preview (${rollup.totalEntries} queued entries; ${cleared ? "cleared" : "queue preserved"}). Add --submit, --url, --out FILE, or --clear.`);
  return 0;
}

export async function runReportCommand(ctx: CommandRunContext): Promise<number> {
  if (!ctx.repoRoot) throw new Error("CommandRunContext.repoRoot is required.");
  if (ctx.args.includes("--flush")) return runFlushMode(ctx);
  const registry = await ctx.host.readRegistry(ctx.repoRoot);
  const payload = buildReportPayload({ repoRoot: ctx.repoRoot, args: ctx.args, registry });
  if (ctx.args.includes("--local")) {
    const queued = appendFeedbackEntry(ctx.repoRoot, payload);
    if (ctx.asJson) {
      console.log(JSON.stringify({ queued: true, queuePath: FEEDBACK_QUEUE_REL, count: queued.count, payload }, null, 2));
    } else {
      console.log(`Queued redacted feedback in ${FEEDBACK_QUEUE_REL} (${queued.count} entry/entries queued). Run 'featlock report --flush' when ready.`);
    }
    return 0;
  }
  const outPath = parseFlag(ctx.args, "--out");
  const wantUrl = ctx.args.includes("--url");
  const wantSubmit = ctx.args.includes("--submit");

  if (outPath) {
    const absOut = path.isAbsolute(outPath) ? outPath : path.resolve(ctx.repoRoot, outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, payload.markdown, "utf8");
  }

  let submittedUrl: string | null = null;
  let submitFallback: string | null = null;
  if (wantSubmit) {
    const sub = submitTextViaGh({ kind: payload.kind, title: payload.title, body: payload.markdown }, process.env.FEATLOCK_GH_BIN ?? "gh");
    if (sub.ok) submittedUrl = sub.output;
    else submitFallback = sub.output;
  }

  if (ctx.asJson) {
    console.log(JSON.stringify({ ...payload, writtenTo: outPath ?? null, submittedUrl, submitFallback }, null, 2));
    return 0;
  }
  if (wantSubmit) {
    if (submittedUrl) console.log(`Filed GitHub issue: ${submittedUrl}`);
    else console.warn(`Could not auto-submit via gh (${submitFallback}). Open pre-filled issue URL instead:\n${payload.url}`);
    return 0;
  }
  if (wantUrl) {
    console.log(payload.url);
    if (payload.urlTruncated) console.warn("Note: URL body was truncated to fit GitHub URL limits; use --out <file> for the full report.");
    return 0;
  }
  if (outPath) {
    console.log(`Wrote redacted report to ${outPath}`);
    return 0;
  }
  console.log(payload.markdown);
  console.log("Dry-run preview (nothing sent). Next steps:\n  --local    Queue offline into .verification/tool-feedback.jsonl\n  --submit   File directly via gh CLI\n  --url      Print a pre-filled GitHub issue URL\n  --out FILE Save the redacted report to disk");
  return 0;
}
