import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";

const SITE_URL = "https://base64.example.com";
let server: Awaited<ReturnType<typeof startServer>>;
let base: string;

beforeAll(async () => {
  server = await startServer({ hostname: "127.0.0.1", port: 0, siteUrl: SITE_URL });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, { decompress: false, ...init });

describe("home page", () => {
  test("serves semantic, indexable HTML", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await res.text();
    expect(html).toContain('<html lang="en"');
    expect(html).toContain(`<link rel="canonical" href="${SITE_URL}/">`);
    expect(html).toContain(`<meta property="og:image" content="${SITE_URL}/og.png">`);
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    expect(html).toContain('<label class="source-label" for="source">');
    // One workbench: a single preview, and one primary action per state (open when empty, copy once loaded).
    expect(html.match(/<figure /g)).toHaveLength(1);
    expect(html.match(/class="button is-primary[" ]/g)).toHaveLength(2);
  });

  test("embeds valid JSON-LD matching the visible FAQ", async () => {
    const html = await (await get("/")).text();
    const json = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)?.[1];
    const data = JSON.parse(json!);
    const types = data["@graph"].map((node: { "@type": string }) => node["@type"]);
    expect(types).toEqual(["WebSite", "WebApplication", "FAQPage"]);
    const faq = data["@graph"][2].mainEntity as { name: string }[];
    for (const { name } of faq) expect(html).toContain(`<h3>${name.replaceAll("'", "&#39;")}</h3>`);
  });

  test("allows the inline stylesheet through its CSP hash", async () => {
    const res = await get("/");
    const html = await res.text();
    const css = html.match(/<style>(.*?)<\/style>/s)![1]!;
    const hash = new Bun.CryptoHasher("sha256").update(css).digest("base64");
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toContain(`style-src 'sha256-${hash}'`);
    expect(csp).toContain("script-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("serves the client script and fonts it references", async () => {
    const html = await (await get("/")).text();
    const script = html.match(/<script type="module" src="([^"]+)"/)![1]!;
    const res = await get(script);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toContain("iVBORw0KGgo");
    for (const [, font] of html.matchAll(/<link rel="preload" href="([^"]+)" as="font"/g)) {
      expect((await get(font!)).headers.get("content-type")).toBe("font/woff2");
    }
  });
});

test("serves the compression worker and allows it in the CSP", async () => {
  const res = await get("/");
  expect(res.headers.get("content-security-policy")).toContain("worker-src 'self'");
  const html = await res.text();
  const worker = html.match(/data-worker="([^"]+)"/)![1]!;
  expect(worker).toMatch(/^\/assets\/reduce-worker-.+\.js$/);
  const script = await get(worker);
  expect(script.status).toBe(200);
  expect(script.headers.get("content-type")).toStartWith("text/javascript");
});

describe("HTTP behaviour", () => {
  test("compresses with Brotli, then gzip", async () => {
    const br = await get("/", { headers: { "Accept-Encoding": "gzip, br" } });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    const gzip = await get("/", { headers: { "Accept-Encoding": "gzip, br;q=0" } });
    expect(gzip.headers.get("content-encoding")).toBe("gzip");
    const plain = await get("/", { headers: { "Accept-Encoding": "identity" } });
    expect(plain.headers.get("content-encoding")).toBeNull();
  });

  test("answers conditional requests with 304", async () => {
    const first = await get("/", { headers: { "Accept-Encoding": "br" } });
    const etag = first.headers.get("etag")!;
    const second = await get("/", { headers: { "Accept-Encoding": "br", "If-None-Match": etag } });
    expect(second.status).toBe(304);
  });

  test("supports HEAD without a body", async () => {
    const res = await get("/robots.txt", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("rejects other methods", async () => {
    const res = await get("/", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });

  test("returns a noindex 404 page", async () => {
    const res = await get("/nope");
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain('<script type="module"');
  });

  test("derives the origin from the request when SITE_URL is unset", async () => {
    const local = await startServer({ hostname: "127.0.0.1", port: 0, siteUrl: null });
    try {
      const res = await fetch(`http://127.0.0.1:${local.port}/robots.txt`, {
        headers: { "X-Forwarded-Proto": "https" },
      });
      expect(await res.text()).toContain(`Sitemap: https://127.0.0.1:${local.port}/sitemap.xml`);
    } finally {
      local.stop(true);
    }
  });
});

describe("crawler documents", () => {
  test("robots.txt points to the sitemap", async () => {
    expect(await (await get("/robots.txt")).text()).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
  });

  test("sitemap.xml lists the home page", async () => {
    const res = await get("/sitemap.xml");
    expect(res.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await res.text()).toContain(`<loc>${SITE_URL}/</loc>`);
  });

  test("llms.txt summarises the tool", async () => {
    const text = await (await get("/llms.txt", { headers: { "Accept-Encoding": "identity" } })).text();
    expect(text).toStartWith("# Base64 Reduce\n\n> ");
    expect(text).toContain("## Frequently asked questions");
  });

  test("the manifest and icons are served", async () => {
    const manifest = (await (await get("/manifest.webmanifest")).json()) as { icons: { src: string; type: string }[] };
    for (const icon of manifest.icons) {
      const res = await get(icon.src);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(icon.type);
    }
  });

  test("health check", async () => {
    const res = await get("/healthz");
    expect(await res.text()).toBe("ok\n");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
