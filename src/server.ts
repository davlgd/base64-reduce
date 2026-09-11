import { watch } from "node:fs";
import { join } from "node:path";
import { buildStaticBundle, type StaticBundle } from "./bundle.ts";
import { loadConfig, type Config } from "./config.ts";
import { CACHE, createAsset, send, type Asset } from "./http.ts";
import { renderLlmsTxt, renderManifest, renderRobots, renderSitemap } from "./site/documents.ts";
import { renderHomePage, renderNotFoundPage } from "./site/page.ts";

/** Documents whose content embeds the public origin (canonical URL, sitemap…). */
interface OriginDocuments {
  readonly routes: ReadonlyMap<string, Asset>;
  readonly notFound: Asset;
}

const MAX_CACHED_ORIGINS = 16;
const TEXT = "text/plain; charset=utf-8";
const HTML = "text/html; charset=utf-8";

/** Everything derived from one client build. */
function prepareSite(bundle: StaticBundle) {
  const staticRoutes = new Map<string, Asset>(bundle.files);
  staticRoutes.set("/manifest.webmanifest", createAsset(renderManifest(), "application/manifest+json", CACHE.day));
  staticRoutes.set("/healthz", createAsset("ok\n", TEXT, CACHE.none));
  const byOrigin = new Map<string, OriginDocuments>();
  return {
    headers: securityHeaders(bundle.cssHash),
    staticRoutes,
    documentsFor(origin: string): OriginDocuments {
      const cached = byOrigin.get(origin);
      if (cached) return cached;
      const documents = renderOriginDocuments(origin, bundle);
      if (byOrigin.size < MAX_CACHED_ORIGINS) byOrigin.set(origin, documents);
      return documents;
    },
  };
}

export interface ServerOptions {
  /** Rebuild the client when `src/client` changes: `bun --watch` only follows the server's own imports. */
  readonly watchClient?: boolean;
}

export async function startServer(config: Config, { watchClient = false }: ServerOptions = {}) {
  let site = prepareSite(await buildStaticBundle());

  if (watchClient) {
    let pending: ReturnType<typeof setTimeout> | undefined;
    watch(join(import.meta.dir, "client"), { recursive: true }, () => {
      clearTimeout(pending);
      pending = setTimeout(async () => {
        try {
          site = prepareSite(await buildStaticBundle());
          console.log("Client rebuilt");
        } catch (error) {
          console.error(error);
        }
      }, 100);
    });
  }

  // A lookup in `fetch` rather than Bun.serve's `routes`: every response goes through `send`
  // (encoding negotiation, ETags), some pages depend on the request origin, and a client
  // rebuild swaps the whole table at once.
  return Bun.serve({
    hostname: config.hostname,
    port: config.port,
    fetch(req) {
      const { headers, staticRoutes } = site;
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method not allowed\n", {
          status: 405,
          headers: { ...headers, Allow: "GET, HEAD", "Content-Type": TEXT },
        });
      }
      const { pathname } = new URL(req.url);
      const asset = staticRoutes.get(pathname);
      if (asset) return send(req, asset, headers);

      const documents = site.documentsFor(config.siteUrl ?? requestOrigin(req));
      const page = documents.routes.get(pathname);
      if (page) return send(req, page, headers);
      return send(req, documents.notFound, headers, 404);
    },
    error(error) {
      console.error(error);
      return new Response("Internal server error\n", {
        status: 500,
        headers: { ...site.headers, "Content-Type": TEXT },
      });
    },
  });
}

function renderOriginDocuments(origin: string, bundle: StaticBundle): OriginDocuments {
  return {
    routes: new Map([
      ["/", createAsset(renderHomePage(origin, bundle), HTML, CACHE.revalidate)],
      ["/robots.txt", createAsset(renderRobots(origin), TEXT, CACHE.hour)],
      ["/sitemap.xml", createAsset(renderSitemap(origin), "application/xml; charset=utf-8", CACHE.hour)],
      ["/llms.txt", createAsset(renderLlmsTxt(origin), TEXT, CACHE.hour)],
    ]),
    notFound: createAsset(renderNotFoundPage(origin, bundle), HTML, CACHE.none),
  };
}

/** Origin as seen by the visitor, honouring the scheme set by a TLS-terminating proxy. */
function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
  return url.origin;
}

function securityHeaders(cssHash: string): Record<string, string> {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "worker-src 'self'",
    `style-src 'sha256-${cssHash}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return {
    "Content-Security-Policy": csp,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

if (import.meta.main) {
  const server = await startServer(loadConfig(), { watchClient: process.env.DEV === "1" });
  console.log(`Base64 Reduce listening on http://${server.hostname}:${server.port}`);
  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
