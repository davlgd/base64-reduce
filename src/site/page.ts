import packageJson from "../../package.json" with { type: "json" };
import { FAQ, FEATURES, SITE } from "./content.ts";
import { escapeHtml } from "./html.ts";

export interface PageAssets {
  /** Inlined stylesheet, allowed by the CSP through its hash. */
  readonly css: string;
  readonly scriptPath: string;
  /** Compression worker, started on demand by the page script. */
  readonly workerPath: string;
  readonly fontPreloads: readonly string[];
}

/** JSON safe to embed in a `<script>` data block. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function structuredData(origin: string): unknown {
  const url = `${origin}/`;
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${url}#website`,
        url,
        name: SITE.name,
        description: SITE.description,
        inLanguage: "en",
      },
      {
        "@type": "WebApplication",
        "@id": `${url}#app`,
        url,
        name: SITE.name,
        description: SITE.description,
        image: `${origin}/og.png`,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Any (web browser)",
        browserRequirements: "Requires JavaScript",
        inLanguage: "en",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        softwareVersion: packageJson.version,
        license: SITE.license,
        author: { "@type": "Person", name: SITE.author.name, url: SITE.author.url },
        featureList: FEATURES,
        isPartOf: { "@id": `${url}#website` },
      },
      {
        "@type": "FAQPage",
        "@id": `${url}#faq`,
        inLanguage: "en",
        mainEntity: FAQ.map((entry) => ({
          "@type": "Question",
          name: entry.question,
          acceptedAnswer: { "@type": "Answer", text: entry.answerText },
        })),
      },
    ],
  };
}

/** A 2 × 2 transparency grid with one yellow cell: the one visual motif of the site. */
const BRAND_MARK = `<svg class="brand-mark" viewBox="0 0 22 22" width="22" height="22" aria-hidden="true" focusable="false">
<rect class="brand-cell is-accent" width="11" height="11" rx="2"/><rect class="brand-cell is-faint" x="11" width="11" height="11" rx="2"/>
<rect class="brand-cell is-faint" y="11" width="11" height="11" rx="2"/><rect class="brand-cell" x="11" y="11" width="11" height="11" rx="2"/>
</svg>`;

interface Shell {
  readonly origin: string;
  readonly title: string;
  readonly description: string;
  readonly robots: string;
  readonly head?: string;
  /** Only the workbench page ships the client script. */
  readonly script?: boolean;
  readonly body: string;
}

function renderShell(assets: PageAssets, shell: Shell): string {
  const origin = escapeHtml(shell.origin);
  const preloads = assets.fontPreloads
    .map((href) => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`)
    .join("\n");
  return `<!doctype html>
<html lang="${SITE.lang}" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(shell.title)}</title>
<meta name="description" content="${escapeHtml(shell.description)}">
<meta name="robots" content="${shell.robots}">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="${SITE.colors.paper}">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${SITE.colors.paperDark}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
${preloads}
${shell.head ?? ""}
<style>${assets.css}</style>
${shell.script ? `<script type="module" src="${assets.scriptPath}"></script>` : ""}
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="masthead wrap">
<a class="brand" href="${origin}/">${BRAND_MARK}<span>${escapeHtml(SITE.name)}</span></a>
<a class="masthead-link" href="#faq">FAQ</a>
</header>
${shell.body}
<footer class="site-footer wrap">
<p>Written with <span role="img" aria-label="love">♥</span> by <a href="${SITE.author.url}">${SITE.author.name}</a>. ${escapeHtml(SITE.privacy)} It's <a href="${SITE.repository}" target="_blank" rel="noopener">open source software</a>.</p>
<p><a href="/llms.txt">llms.txt</a></p>
</footer>
</body>
</html>
`;
}

const PALETTE_SIZES = [256, 128, 64, 32, 16, 8, 4, 2];
const BACKDROPS = [
  ["checker", "Checkerboard"],
  ["light", "White"],
  ["dark", "Black"],
] as const;

/** Small line icons, drawn with the text colour. */
const ICONS = {
  open: '<path d="M12 15V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  paste: '<path d="M9 4.5h6M9 4.5A1.5 1.5 0 0 0 7.5 6v0H6.5A1.5 1.5 0 0 0 5 7.5v11A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 17.5 6h-1v0A1.5 1.5 0 0 0 15 4.5M9 4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  download: '<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"/>',
} as const;

function icon(name: keyof typeof ICONS): string {
  return `<svg class="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

function renderWorkbench(workerPath: string): string {
  return `<section id="workbench" class="workbench" data-state="empty" aria-label="Workbench" data-worker="${escapeHtml(workerPath)}">
<form id="viewer" class="source" novalidate>
<div class="source-bar">
<ul class="facts" aria-label="Source image">
<li id="fact-format"></li>
<li id="fact-dimensions"></li>
<li id="fact-size"></li>
</ul>
<div class="source-bar-actions">
<button type="button" id="edit-source" class="button is-quiet" aria-expanded="false" aria-controls="source-editor">Edit Base64</button>
<button type="button" id="clear" class="button is-quiet">Start over</button>
</div>
</div>
<div id="source-editor" class="source-editor">
<label class="source-label" for="source">Paste a Base64 string or data URI</label>
<textarea id="source" name="source" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" translate="no" placeholder="data:image/png;base64,iVBORw0KGgo…" aria-describedby="source-hint source-error"></textarea>
<p id="source-error" class="field-error" hidden></p>
<div class="source-tools">
<span class="file-picker"><input type="file" id="file" class="visually-hidden" accept="image/*,.txt,.b64,text/plain"><label for="file" class="button is-primary">${icon("open")}Open an image</label></span>
<button type="button" id="paste" class="button" hidden>${icon("paste")}Paste</button>
<button type="button" id="sample" class="button is-link">Try an example</button>
</div>
<p id="source-hint" class="hint">You can also drop an image anywhere on this page. Nothing is uploaded.<span class="shortcut"> <kbd id="shortcut-key">Ctrl</kbd> + <kbd>Enter</kbd> decodes right away.</span></p>
</div>
<noscript><p class="field-error">This tool needs JavaScript: images are decoded in your browser, never on a server.</p></noscript>
</form>

<div class="view">
<figure id="stage" class="stage" data-backdrop="checker">
<div class="stage-canvas"><img id="preview-image" alt="" hidden></div>
<fieldset class="tabs">
<legend class="visually-hidden">Show</legend>
<label><input type="radio" name="view" id="view-original" value="original" checked><span>Original</span></label>
<label><input type="radio" name="view" id="view-result" value="result" disabled><span>Result</span></label>
</fieldset>
<fieldset class="swatches">
<legend class="visually-hidden">Preview background</legend>
${BACKDROPS.map(
  ([value, label], i) =>
    `<label class="swatch" title="${label}"><input type="radio" name="backdrop" value="${value}"${i === 0 ? " checked" : ""}><span class="swatch-chip is-${value}"></span><span class="visually-hidden">${label}</span></label>`,
).join("\n")}
</fieldset>
<p class="drop-hint" aria-hidden="true">Drop to load</p>
</figure>
</div>

<div class="panel">
<div id="output" class="result" aria-busy="true">
<p id="verdict" class="verdict">Compressing…</p>
<p id="verdict-detail" class="verdict-detail"></p>
<div class="meter-row" aria-hidden="true"><div class="meter"><span class="meter-fill" id="bar-result"></span></div><span class="meter-label">Result size</span></div>
<p id="result-meta" class="result-meta"></p>
<p id="output-note" class="notice" hidden></p>
<p id="reduce-warning" class="notice" hidden></p>
<button type="button" id="reduced-copy" class="button is-primary is-block" disabled>${icon("copy")}<span class="button-label">Copy data URI</span></button>
<div class="result-actions">
<a id="reduced-download" class="button">${icon("download")}Download</a>
<button type="button" id="reduced-use" class="button is-quiet" disabled>Use as new source</button>
</div>
<details id="result-more" class="result-more">
<summary>Text and original</summary>
<div class="result-more-body">
<label for="reduced-output">Result data URI</label>
<input id="reduced-output" class="output-string" readonly spellcheck="false" translate="no">
<div class="result-actions">
<button type="button" id="original-copy" class="button is-quiet">Copy original</button>
<a id="original-download" class="button is-quiet" download>Download original</a>
</div>
</div>
</details>
<p id="output-summary" class="visually-hidden"></p>
<p id="reduce-status" class="visually-hidden" role="status"></p>
</div>

<details id="settings-panel" class="settings">
<summary><span class="settings-title">Adjust compression</span></summary>
<form id="reduce-form" novalidate>
<fieldset id="settings" class="settings-body">
<legend class="visually-hidden">Compression settings</legend>
<fieldset class="field">
<legend>Format</legend>
<div id="reduce-format" class="choices"></div>
<p id="reduce-format-hint" class="hint"></p>
</fieldset>
<div class="field" id="field-quality">
<div class="field-row"><label for="reduce-quality">Quality</label><output id="reduce-quality-value" for="reduce-quality">80</output></div>
<input type="range" id="reduce-quality" min="10" max="100" step="1" value="80" aria-describedby="reduce-quality-hint">
<p id="reduce-quality-hint" class="visually-hidden">Lower quality can shrink the image and its detail.</p>
</div>
<div class="field" id="field-colors" hidden>
<label for="reduce-colors">Colors</label>
<select id="reduce-colors">
<option value="0">All colors (lossless)</option>
${PALETTE_SIZES.map((n) => `<option value="${n}">${n} colors</option>`).join("\n")}
</select>
</div>
<div class="field" id="field-size">
<div class="field-row"><label for="reduce-scale">Size</label><output id="reduce-size-value" for="reduce-scale"></output></div>
<input type="range" id="reduce-scale" min="5" max="100" step="1" value="100">
</div>
<details id="more-options" class="more-options">
<summary>More options</summary>
<div class="more-options-body">
<div class="field" id="field-width">
<label for="reduce-width">Exact width (px)</label>
<input type="number" id="reduce-width" inputmode="numeric" min="1" step="1">
</div>
<div class="field-check" id="field-dither">
<input type="checkbox" id="reduce-dither" checked>
<label for="reduce-dither">Dithering for fewer colors</label>
</div>
<div class="field" id="field-background">
<label for="reduce-background">JPEG fill color</label>
<input type="color" id="reduce-background" value="#ffffff" aria-describedby="reduce-background-hint">
<p id="reduce-background-hint" class="hint">Replaces transparent areas.</p>
</div>
<div class="field-check" id="field-precision">
<input type="checkbox" id="reduce-precision" checked>
<label for="reduce-precision">Round SVG coordinates to 3 decimals</label>
</div>
</div>
</details>
</fieldset>
</form>
</details>
</div>
<p id="status" class="visually-hidden" role="status"></p>
</section>`;
}

export function renderHomePage(origin: string, assets: PageAssets): string {
  const url = escapeHtml(`${origin}/`);
  const head = `<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:locale" content="${SITE.locale}">
<meta property="og:site_name" content="${escapeHtml(SITE.name)}">
<meta property="og:title" content="${escapeHtml(SITE.heading)}">
<meta property="og:description" content="${escapeHtml(SITE.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${escapeHtml(`${origin}/og.png`)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${escapeHtml(`${SITE.name}: a data URI shrinking from 4,190 to 2,006 characters next to the decoded image.`)}">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${jsonForScript(structuredData(origin))}</script>`;

  const faq = FAQ.map(
    (entry, i) =>
      `<details class="faq-item"${i === 0 ? " open" : ""}><summary><h3>${escapeHtml(entry.question)}</h3></summary><div class="faq-answer">${entry.answerHtml}</div></details>`,
  ).join("\n");

  const body = `<main id="main" class="wrap">
<div class="intro">
<h1>${escapeHtml(SITE.heading)}</h1>
<p class="lede">${escapeHtml(SITE.lede)}</p>
</div>
${renderWorkbench(assets.workerPath)}
<section id="faq" class="faq" aria-labelledby="faq-title">
<h2 id="faq-title">Questions</h2>
<div class="faq-list">
${faq}
</div>
</section>
</main>`;

  return renderShell(assets, {
    origin,
    title: SITE.title,
    description: SITE.description,
    robots: "index, follow, max-image-preview:large, max-snippet:-1",
    head,
    script: true,
    body,
  });
}

export function renderNotFoundPage(origin: string, assets: PageAssets): string {
  const body = `<main id="main" class="wrap">
<div class="intro">
<h1>Page not found</h1>
<p class="lede">There is nothing at this address. The workbench is on the home page.</p>
<p><a class="button is-primary" href="${escapeHtml(origin)}/">Open ${escapeHtml(SITE.name)}</a></p>
</div>
</main>`;
  return renderShell(assets, {
    origin,
    title: `Page not found | ${SITE.name}`,
    description: SITE.description,
    robots: "noindex",
    body,
  });
}
