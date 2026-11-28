import type { FeatlockStudioData, HostApiFacade, StudioHttpRouteSpec } from "@featlock/plugin";

export interface StudioServerOptions {
  readonly host: HostApiFacade;
  readonly repoRoot: string;
  readonly port: number;
  readonly rendererId?: string;
}

export interface StudioServerHandle {
  readonly url: string;
  readonly port: number;
  readonly stop: () => void;
}

function collectCustomRoutes(host: HostApiFacade, rendererId?: string): readonly StudioHttpRouteSpec[] {
  const st = host.getStudioState();
  const active = rendererId
    ? st.renderers.find((r) => r.id === rendererId)
    : (st.defaultRenderer ?? st.renderers[0]);
  return active?.routes ?? [];
}

async function dispatchStudioRequest(
  req: Request,
  ctx: {
    readonly host: HostApiFacade;
    readonly repoRoot: string;
    readonly rendererId?: string;
    readonly customRoutes: readonly StudioHttpRouteSpec[];
    readonly getData: (refresh?: boolean) => Promise<FeatlockStudioData>;
  },
): Promise<Response> {
  if (!req || !req.url) throw new Error("HTTP Request with url is required.");
  const url = new URL(req.url);
  for (const route of ctx.customRoutes) {
    const expectedMethod = route.method ?? "GET";
    if (url.pathname === route.path && req.method === expectedMethod) {
      return await route.handle(req, () => ctx.getData(url.searchParams.get("refresh") === "1"));
    }
  }
  if (url.pathname === "/api/health") {
    return Response.json({ ok: true, repoRoot: ctx.repoRoot });
  }
  if (url.pathname === "/api/plugins") {
    return Response.json({ plugins: ctx.host.listPlugins() });
  }
  if (url.pathname === "/api/data") {
    const data = await ctx.getData(url.searchParams.get("refresh") === "1");
    return Response.json(data);
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const data = await ctx.getData(url.searchParams.get("refresh") === "1");
    const html = await ctx.host.renderStudio(data, { rendererId: ctx.rendererId });
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("Not Found", { status: 404 });
}

export function startStudioServer(opts: StudioServerOptions): StudioServerHandle {
  if (!opts.repoRoot) throw new Error("repoRoot is required to start FeatLock Studio server.");
  let cached: FeatlockStudioData | null = null;
  const getData = async (refresh = false): Promise<FeatlockStudioData> => {
    if (!cached || refresh) cached = await opts.host.collectStudioData(opts.repoRoot);
    return cached;
  };
  const customRoutes = collectCustomRoutes(opts.host, opts.rendererId);
  const handleRequest = (req: Request): Promise<Response> =>
    dispatchStudioRequest(req, {
      host: opts.host,
      repoRoot: opts.repoRoot,
      rendererId: opts.rendererId,
      customRoutes,
      getData,
    });

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch: handleRequest,
  });

  const boundPort = server.port ?? opts.port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    stop: () => {
      void server.stop(true);
    },
  };
}
