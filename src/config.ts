export interface Config {
  readonly hostname: string;
  readonly port: number;
  /** Public origin used for canonical URLs and the sitemap; derived from each request when unset. */
  readonly siteUrl: string | null;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    hostname: "0.0.0.0",
    port: parsePort(env.PORT),
    siteUrl: parseSiteUrl(env.SITE_URL),
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 8080;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: "${value}" (expected an integer from 0 to 65535)`);
  }
  return port;
}

function parseSiteUrl(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid SITE_URL: "${value}" (expected an absolute URL, for example https://base64.example.com)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`SITE_URL must use http or https: "${value}"`);
  }
  return url.origin;
}
