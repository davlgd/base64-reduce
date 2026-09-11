import { basename, extname, join } from "node:path";
import { CACHE, createAsset, type Asset } from "./http.ts";
import type { PageAssets } from "./site/page.ts";

export interface StaticBundle extends PageAssets {
  /** SHA-256 of the inlined stylesheet, for the Content-Security-Policy. */
  readonly cssHash: string;
  /** Files served as-is, keyed by URL path. */
  readonly files: ReadonlyMap<string, Asset>;
}

const CLIENT_DIR = join(import.meta.dir, "client");
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

/** Fonts referenced from styles.css as `/fonts/<name>`, mapped to their npm files. */
const FONTS: Record<string, string> = {
  "atkinson-hyperlegible-next.woff2":
    "@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2",
  "atkinson-hyperlegible-mono.woff2":
    "@fontsource-variable/atkinson-hyperlegible-mono/files/atkinson-hyperlegible-mono-latin-wght-normal.woff2",
};

/** Bundles the client with Bun's bundler, in memory, when the server starts. */
export async function buildStaticBundle(): Promise<StaticBundle> {
  const result = await Bun.build({
    entrypoints: [join(CLIENT_DIR, "app.ts"), join(CLIENT_DIR, "reduce-worker.ts"), join(CLIENT_DIR, "styles.css")],
    target: "browser",
    minify: true,
    naming: "[name]-[hash].[ext]",
    publicPath: "/assets/",
    // Bun's CSS bundler would inline the fonts as data URIs; they are served separately instead.
    external: ["/fonts/*"],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "Client build failed");
  }

  const files = new Map<string, Asset>();
  let css = "";
  let scriptPath = "";
  let workerPath = "";
  const fontPreloads: string[] = [];

  for (const output of result.outputs) {
    const name = basename(output.path);
    const path = `/assets/${name}`;
    const extension = extname(name);
    if (extension === ".css") {
      css = (await output.text()).trim();
      continue;
    }
    if (output.kind === "entry-point" && extension === ".js") {
      if (name.startsWith("reduce-worker-")) workerPath = path;
      else scriptPath = path;
    }
    files.set(path, createAsset(new Uint8Array(await output.arrayBuffer()), output.type, CACHE.immutable));
  }
  if (!css || !scriptPath || !workerPath) throw new Error("The client bundle is missing its script, worker or stylesheet");

  // Content-hashed font URLs, so they can be cached forever.
  for (const [name, specifier] of Object.entries(FONTS)) {
    const file = Bun.file(Bun.resolveSync(specifier, import.meta.dir));
    const bytes = await file.bytes();
    const path = `/fonts/${name.replace(/\.woff2$/, "")}-${Bun.hash(bytes).toString(36)}.woff2`;
    if (!css.includes(`/fonts/${name}`)) throw new Error(`Font /fonts/${name} is not referenced by styles.css`);
    css = css.replaceAll(`/fonts/${name}`, path);
    fontPreloads.push(path);
    files.set(path, createAsset(bytes, file.type, CACHE.immutable));
  }

  for await (const name of new Bun.Glob("*").scan({ cwd: PUBLIC_DIR })) {
    const file = Bun.file(join(PUBLIC_DIR, name));
    files.set(`/${name}`, createAsset(await file.bytes(), file.type, CACHE.day));
  }

  const cssHash = new Bun.CryptoHasher("sha256").update(css).digest("base64");
  return { css, cssHash, scriptPath, workerPath, fontPreloads, files };
}
