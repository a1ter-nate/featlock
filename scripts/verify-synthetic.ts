import path from "node:path";
import { createPluginHost } from "@featlock/core";
import { startStudioServer } from "../packages/plugins/studio/src/index.ts";

async function runSyntheticProbe(): Promise<void> {
  const root = path.resolve(import.meta.dir, "..");
  const host = await createPluginHost({ repoDir: root, includeBuiltins: true });
  try {
    const started = performance.now();
    const srv = startStudioServer({ host, repoRoot: root, port: 0 });
    try {
      const signal = AbortSignal.timeout(10_000);
      const [homeRes, dataRes] = await Promise.all([
        fetch(`${srv.url}/`, { signal }),
        fetch(`${srv.url}/api/data`, { signal }),
      ]);
      if (homeRes.status !== 200) throw new Error(`Studio synthetic probe / returned HTTP ${homeRes.status}`);
      if (dataRes.status !== 200) throw new Error(`Studio synthetic probe /api/data returned HTTP ${dataRes.status}`);
      const body = await homeRes.text();
      if (!body.includes("featlock-data")) throw new Error("Studio synthetic probe missing featlock-data payload");
      const data = (await dataRes.json()) as { counts: { features: number; invariants: number } };
      const elapsedMs = Math.round(performance.now() - started);
      console.log(JSON.stringify({ ok: true, probe: "featlock-studio-synthetic", counts: data.counts, elapsedMs }));
    } finally {
      srv.stop();
    }
  } finally {
    await host.dispose();
  }
}

await runSyntheticProbe();
