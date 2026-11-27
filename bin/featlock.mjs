#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcCli = path.join(rootDir, "src", "cli.ts");
const distCli = path.join(rootDir, "dist", "cli.mjs");

const entry = fs.existsSync(srcCli) ? srcCli : distCli;
await import(pathToFileURL(entry).href);
