import { FAQ, FEATURES, SITE, STEPS } from "./content.ts";

export function renderRobots(origin: string): string {
  return `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
}

export function renderSitemap(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${origin}/</loc>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
}

/** Summary for AI assistants, following https://llmstxt.org. */
export function renderLlmsTxt(origin: string): string {
  return `# ${SITE.name}

> ${SITE.description}

Address: ${origin}/
Language: English. Free to use, no account required. ${SITE.privacy}
Source code: ${SITE.repository} (Apache License 2.0), by ${SITE.author.name} (${SITE.author.url}).

## Features

${FEATURES.map((feature) => `- ${feature}`).join("\n")}

## Input and output

- Input: raw Base64 or a data URI (standard or URL-safe alphabet, with or without whitespace, quotes or a CSS url(...) wrapper); SVG data URIs may be Base64 or URL-encoded; image files up to 25 MB can be opened or dropped.
- Output: a Base64 data URI, or the image file. Output formats depend on the encoders the browser provides (PNG always; WebP, JPEG and AVIF when available).
- Auto mode keeps the shortest data URI, counting the MIME prefix and padding, and keeps the original at unchanged dimensions when nothing is shorter. Its PNG candidate is lossless and is skipped above 4 million pixels.

## How to use

${STEPS.map((step, i) => `${i + 1}. ${step.title}: ${step.text}`).join("\n")}

## Frequently asked questions

${FAQ.map((entry) => `### ${entry.question}\n\n${entry.answerText}`).join("\n\n")}
`;
}

export function renderManifest(): string {
  return JSON.stringify(
    {
      name: SITE.name,
      short_name: SITE.shortName,
      description: SITE.description,
      lang: SITE.lang,
      dir: "ltr",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: SITE.colors.paper,
      theme_color: SITE.colors.paper,
      categories: ["developer", "utilities"],
      icons: [
        { src: "/favicon.svg", type: "image/svg+xml", sizes: "any", purpose: "any" },
        { src: "/icon-192.png", type: "image/png", sizes: "192x192", purpose: "any" },
        { src: "/icon-512.png", type: "image/png", sizes: "512x512", purpose: "any" },
        { src: "/icon-maskable-512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
      ],
    },
    null,
    2,
  );
}
