import fs from "node:fs";
import path from "node:path";
import { Plugin, type CommandRunContext } from "@featlock/plugin";
import { renderDefaultStudioHtml } from "./render.ts";
import { startStudioServer } from "./server.ts";

export { renderDefaultStudioHtml, startStudioServer };

function parseFlag(args: readonly string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const cur = args[i] ?? "";
    if (cur === flag) return args[i + 1];
    if (cur.startsWith(`${flag}=`)) return cur.slice(flag.length + 1);
  }
  return undefined;
}

function handleListFlags(ctx: CommandRunContext): number | null {
  const st = ctx.host.getStudioState();
  if (ctx.args.includes("--list-renderers")) {
    const list = st.renderers.map((r) => ({ id: r.id, label: r.label ?? r.id, description: r.description ?? "" }));
    if (ctx.asJson) console.log(JSON.stringify(list, null, 2));
    else for (const r of list) console.log(`${r.id}  ${r.label}${r.description ? ` — ${r.description}` : ""}`);
    return 0;
  }
  if (ctx.args.includes("--list-tabs")) {
    const list = st.tabs.map((t) => ({ id: t.id, label: t.label, order: t.order ?? 100 }));
    if (ctx.asJson) console.log(JSON.stringify(list, null, 2));
    else for (const t of list) console.log(`${t.id}  ${t.label}`);
    return 0;
  }
  return null;
}

async function runUiCommand(ctx: CommandRunContext): Promise<number> {
  if (!ctx.repoRoot) throw new Error("repoRoot is required for featlock ui.");
  const listed = handleListFlags(ctx);
  if (listed !== null) return listed;

  const rendererId = parseFlag(ctx.args, "--renderer");
  if (ctx.asJson) {
    const data = await ctx.host.collectStudioData(ctx.repoRoot);
    console.log(JSON.stringify(data, null, 2));
    return 0;
  }
  if (ctx.args.includes("--serve")) {
    const rawPort = Number(parseFlag(ctx.args, "--port") ?? "4318");
    const port = Number.isFinite(rawPort) && rawPort >= 0 ? rawPort : 4318;
    const srv = startStudioServer({ host: ctx.host, repoRoot: ctx.repoRoot, port, rendererId });
    console.log(`FeatLock Studio serving ${ctx.repoRoot} at ${srv.url} (API: ${srv.url}/api/data)`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => { srv.stop(); resolve(); });
      process.once("SIGTERM", () => { srv.stop(); resolve(); });
    });
    return 0;
  }

  const html = await ctx.host.renderStudio(ctx.repoRoot, { rendererId });
  if (ctx.args.includes("--stdout")) {
    process.stdout.write(html);
    return 0;
  }
  const outFlag = parseFlag(ctx.args, "--out");
  const outPath = outFlag ? path.resolve(ctx.repoRoot, outFlag) : path.join(ctx.repoRoot, ".featlock", "studio.html");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, "utf8");
  console.log(`Wrote FeatLock Studio UI to ${outPath}`);
  return 0;
}

export const studioPlugin = Plugin.define({
  id: "featlock.studio",
  async setup(ctx) {
    await ctx.studio.transform((ed) => {
      ed.setRenderer({
        id: "featlock.studio.default",
        label: "FeatLock Studio",
        description: "Built-in interactive HTML/SVG visualization for features, invariants, fences, matrix, and graph.",
        renderHtml: renderDefaultStudioHtml,
      });
    });
    await ctx.command.transform((ed) => {
      ed.add({
        id: "ui",
        description: "Render or serve interactive FeatLock Studio UI (--out, --stdout, --renderer, --serve, --json)",
        run: runUiCommand,
      });
      ed.add({
        id: "studio",
        description: "Alias for 'featlock ui' — render or serve plugin-extensible Studio visualization",
        run: runUiCommand,
      });
    });
  },
});

export default studioPlugin;
