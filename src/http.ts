import { brotliCompressSync, constants } from "node:zlib";

type Encoding = "br" | "gzip";

/** A response body prepared once: hashed for ETags and pre-compressed. */
export interface Asset {
  readonly type: string;
  readonly cacheControl: string;
  readonly variants: { readonly identity: Variant } & Readonly<Partial<Record<Encoding, Variant>>>;
}

interface Variant {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly etag: string;
}

export const CACHE = {
  immutable: "public, max-age=31536000, immutable",
  revalidate: "no-cache",
  hour: "public, max-age=3600",
  day: "public, max-age=86400",
  none: "no-store",
} as const;

const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|xml)|image\/svg\+xml)/;
const MIN_COMPRESS_BYTES = 512;

export function createAsset(content: string | Uint8Array<ArrayBuffer>, type: string, cacheControl: string): Asset {
  const body = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const hash = Bun.hash(body).toString(36);
  const variants: { identity: Variant } & Partial<Record<Encoding, Variant>> = { identity: { body, etag: `"${hash}"` } };
  if (COMPRESSIBLE.test(type) && body.byteLength >= MIN_COMPRESS_BYTES) {
    // Brotli comes from node:zlib (Bun has no native Brotli API); gzip is Bun's own.
    const br = new Uint8Array(brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
    const gzip = Bun.gzipSync(body, { level: 9 });
    if (br.byteLength < body.byteLength) variants.br = { body: br, etag: `"${hash}-br"` };
    if (gzip.byteLength < body.byteLength) variants.gzip = { body: gzip, etag: `"${hash}-gz"` };
  }
  return { type, cacheControl, variants };
}

export function send(req: Request, asset: Asset, headers: Readonly<Record<string, string>>, status = 200): Response {
  const encoding = negotiate(req.headers.get("accept-encoding"), asset);
  const variant = encoding === "identity" ? asset.variants.identity : (asset.variants[encoding] ?? asset.variants.identity);
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", asset.type);
  responseHeaders.set("Cache-Control", asset.cacheControl);
  responseHeaders.set("ETag", variant.etag);
  if (asset.variants.br || asset.variants.gzip) responseHeaders.set("Vary", "Accept-Encoding");
  if (encoding !== "identity") responseHeaders.set("Content-Encoding", encoding);

  if (status === 200 && matchesEtag(req.headers.get("if-none-match"), variant.etag)) {
    return new Response(null, { status: 304, headers: responseHeaders });
  }
  if (req.method === "HEAD") {
    responseHeaders.set("Content-Length", String(variant.body.byteLength));
    return new Response(null, { status, headers: responseHeaders });
  }
  return new Response(variant.body, { status, headers: responseHeaders });
}

function negotiate(header: string | null, asset: Asset): Encoding | "identity" {
  if (!header) return "identity";
  const accepted = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    accepted.set(name.trim(), q ? Number.parseFloat(q.slice(2)) || 0 : 1);
  }
  for (const encoding of ["br", "gzip"] as const) {
    const q = accepted.get(encoding) ?? accepted.get("*") ?? 0;
    if (q > 0 && asset.variants[encoding]) return encoding;
  }
  return "identity";
}

function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((tag) => {
    const value = tag.trim();
    return value === "*" || value.replace(/^W\//, "") === etag;
  });
}
