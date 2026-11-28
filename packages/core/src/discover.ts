import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiscoveredFile, LanguageSpec, ScanContext } from "@featlock/plugin";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  ".featlock",
  ".claude",
  ".codex",
  ".cursor",
  ".agents",
  ".amp",
  ".next",
  ".turbo",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "vendor",
  "bin",
  "obj",
]);

const BASE_SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".py", ".rs", ".cs", ".go", ".sql"]);

const NON_LIVE_TEST_RE = /(?:^|\/)(?:examples|fixtures|templates|caught|testdata|snapshots)\//i;

function isTestPath(rel: string, languages?: readonly LanguageSpec[]): boolean {
  if (NON_LIVE_TEST_RE.test(rel)) return false;
  if (languages) {
    for (const lang of languages) {
      if (lang.isTestFile && lang.isTestFile(rel)) return true;
    }
  }
  return (
    /(?:^|\/)(?:tests?|__tests__|spec|caddytest|testmocks)\//i.test(rel) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(rel) ||
    /(?:^|\/)test_[^/]+\.py$/i.test(rel) ||
    /_test\.(?:py|rs|go)$/i.test(rel) ||
    /Tests?\.cs$/i.test(rel)
  );
}

function buildAllowedExts(languages?: readonly LanguageSpec[]): ReadonlySet<string> {
  if (!languages || languages.length === 0) return BASE_SOURCE_EXTS;
  const exts = new Set(BASE_SOURCE_EXTS);
  for (const lang of languages) {
    for (const ext of lang.extensions) {
      const norm = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
      exts.add(norm);
    }
  }
  return exts;
}

export function discoverRepo(
  repoDir: string,
  opts?: { readonly languages?: readonly LanguageSpec[] },
): ScanContext {
  const repoRoot = path.resolve(repoDir);
  if (!fs.existsSync(repoRoot)) {
    throw new Error(`Repository directory does not exist: ${repoRoot}`);
  }
  const allowedExts = buildAllowedExts(opts?.languages);
  const allRelPaths: string[] = [];
  const files: DiscoveredFile[] = [];
  const textCache = new Map<string, string | null>();
  const stack: string[] = [repoRoot];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
        allRelPaths.push(rel);
        const ext = path.extname(entry.name).toLowerCase();
        if (!allowedExts.has(ext)) continue;
        const stat = fs.statSync(abs);
        if (stat.size > 512_000) continue;
        const content = fs.readFileSync(abs, "utf8");
        textCache.set(rel, content);
        files.push({
          rel,
          abs,
          ext,
          isTest: isTestPath(rel, opts?.languages),
          content,
          lines: content.length === 0 ? 0 : content.split("\n").length,
        });
      }
    }
  }

  allRelPaths.sort();
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const readText = (relPath: string): string | null => {
    const hit: string | undefined = textCache.get(relPath) ?? undefined;
    if (textCache.has(relPath)) return hit ?? null;
    const abs = path.join(repoRoot, relPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      textCache.set(relPath, null);
      return null;
    }
    const content = fs.readFileSync(abs, "utf8");
    textCache.set(relPath, content);
    return content;
  };

  return { repoRoot, files, allRelPaths, readText };
}

export function listStagedFiles(repoRoot: string): string[] {
  try {
    const out = execFileSync("git", ["-C", repoRoot, "diff", "--cached", "--name-only"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
