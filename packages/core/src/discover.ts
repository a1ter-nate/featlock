import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { DiscoveredFile, ScanContext } from "@featlock/plugin";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  ".featlock",
  ".next",
  ".turbo",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".mts", ".js", ".mjs", ".py", ".rs", ".cs", ".go", ".sql"]);

function isTestPath(rel: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:py|rs|go)$|Tests?\.cs$/i.test(rel);
}

export function discoverRepo(repoDir: string): ScanContext {
  const repoRoot = path.resolve(repoDir);
  if (!fs.existsSync(repoRoot)) {
    throw new Error(`Repository directory does not exist: ${repoRoot}`);
  }
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
        if (!SOURCE_EXTS.has(ext)) continue;
        const stat = fs.statSync(abs);
        if (stat.size > 512_000) continue;
        const content = fs.readFileSync(abs, "utf8");
        textCache.set(rel, content);
        files.push({
          rel,
          abs,
          ext,
          isTest: isTestPath(rel),
          content,
          lines: content.length === 0 ? 0 : content.split("\n").length,
        });
      }
    }
  }

  allRelPaths.sort();
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  const readText = (relPath: string): string | null => {
    if (textCache.has(relPath)) return textCache.get(relPath) ?? null;
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
