/**
 * Editorial content, shared by the page, its structured data and llms.txt
 * so that what search engines and AI assistants read matches what people see.
 */
import { escapeHtml } from "./html.ts";

export interface FaqEntry {
  readonly question: string;
  /** Trusted HTML shown on the page. */
  readonly answerHtml: string;
  /** Plain-text version for JSON-LD and llms.txt. */
  readonly answerText: string;
}

export interface Step {
  readonly title: string;
  readonly text: string;
}

export const SITE = {
  name: "Base64 Reduce",
  shortName: "Base64 Reduce",
  lang: "en",
  locale: "en_US",
  title: "Base64 to Image Decoder & Compressor | Base64 Reduce",
  description:
    "Decode Base64 to an image, then shrink it: compare WebP, PNG, AVIF and JPEG, clean up SVG and copy a shorter data URI. Runs in your browser, no upload.",
  heading: "Make your Base64 images smaller",
  lede: "Paste a data URI or open an image to see it right away and try a shorter version. It all happens in your browser.",
  privacy: "Your image data stays in your browser.",
  author: { name: "davlgd", url: "https://davlgd.fr" },
  repository: "https://github.com/davlgd/base64-reduce",
  license: "https://www.apache.org/licenses/LICENSE-2.0",
  colors: { paper: "#ffffff", paperDark: "#161616", accent: "#ffd43b" },
} as const;

export const FEATURES: readonly string[] = [
  "Preview Base64 image strings and data URIs, or import image files up to 25 MB",
  "Accept URL-safe Base64, whitespace, surrounding quotes, CSS url(...) wrappers and URL-encoded SVG data URIs",
  "Detect PNG, JPEG, GIF, WebP, AVIF, SVG, BMP and ICO from the decoded bytes, and point at the first invalid character",
  "Compare the original and the result on a checkerboard, white or black background",
  "Auto mode: try each eligible encoder and keep the shortest data URI, prefix and padding included",
  "Lossless PNG optimization, optional palette reduction with dithering, and SVG minification",
  "Adjust format, quality and dimensions; copy the data URI or download the original or the result",
  "Process image data in the browser, without uploading it",
];

export const STEPS: readonly Step[] = [
  {
    title: "Add your image",
    text: "Paste a Base64 string or data URI, or choose Open an image. Check that the preview shows the image you expect.",
  },
  {
    title: "Check the first result",
    text: "Auto tries the eligible formats. Compare the data URI lengths and switch between Original and Result to inspect the image.",
  },
  {
    title: "Adjust if needed",
    text: "Open Adjust compression to change the format, quality or dimensions. Check fine text, edges and transparency before you settle.",
  },
  {
    title: "Copy or download",
    text: "Copy the result data URI for your code or download the file. Text and original holds the untouched source.",
  },
];

/** Leading Base64 characters that hint at a format, shown as a table in the FAQ. */
const SIGNATURES: readonly (readonly [format: string, prefix: string])[] = [
  ["PNG", "iVBORw0KGgo"],
  ["JPEG", "/9j/"],
  ["GIF", "R0lGOD"],
  ["WebP", "UklGR"],
  ["SVG", "PHN2Zy or PD94bWwg"],
  ["ICO", "AAABAA"],
  ["BMP", "Qk"],
];

const LINK = /\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g;

/** Escapes prose and turns [label](https://…) into a link. */
function prose(text: string): string {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    html += escapeHtml(text.slice(last, match.index)) + `<a href="${escapeHtml(match[2]!)}">${escapeHtml(match[1]!)}</a>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(last));
}

/**
 * Answers are written once: `backticks` mark code, [label](url) marks a source, blank lines
 * separate paragraphs. The page gets HTML; JSON-LD and llms.txt get the same words as plain text.
 */
function entry(question: string, answer: string, extra = { html: "", text: "" }): FaqEntry {
  const paragraphs = answer.trim().split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " "));
  const html = paragraphs
    .map((p) => `<p>${p.split("`").map((part, i) => (i % 2 ? `<code>${escapeHtml(part)}</code>` : prose(part))).join("")}</p>`)
    .join("");
  const plain = paragraphs.join(" ").replaceAll("`", "").replace(LINK, "$1 ($2)");
  const text = [plain, extra.text].filter(Boolean).join(" ");
  return { question, answerHtml: html + extra.html, answerText: text };
}

const signatureTable = `<div class="table-scroll"><table class="signatures">
<caption>Common Base64 prefixes</caption>
<thead><tr><th scope="col">Format</th><th scope="col">Usually starts with</th></tr></thead>
<tbody>${SIGNATURES.map(
  ([format, prefix]) =>
    `<tr><th scope="row">${format}</th><td>${prefix
      .split(" or ")
      .map((p) => `<code>${escapeHtml(p)}</code>`)
      .join(" or ")}</td></tr>`,
).join("")}</tbody>
</table></div>`;

export const FAQ: readonly FaqEntry[] = [
  entry(
    "How do I turn a Base64 string back into an image?",
    `Paste it above: raw Base64, a full data URI, or a value copied from CSS or JSON all work, and the tool inspects the decoded bytes to identify the format.

In a page, the complete data URI is the image address: \`<img src="data:image/png;base64,..." alt="Logo">\`, or \`background-image: url("data:image/png;base64,...")\` in CSS. Raw Base64 without the \`data:image/png;base64,\` prefix isn't a valid source on its own. Command-line tools want the opposite, the raw payload without the prefix: \`base64 -d image.txt > image.png\` (older macOS versions use \`-D\`), or \`Buffer.from(payload, "base64")\` in Node.js.`,
  ),
  entry(
    "Why is a Base64 image about a third bigger than the file?",
    `Base64 is an encoding, not compression: it writes every 3 bytes as 4 characters, so n bytes become \`4 × ceil(n / 3)\` characters. A 3,000-byte PNG turns into 4,000 characters, plus the 22-character \`data:image/png;base64,\` prefix, for 4,022 in total.

For real images the overhead settles at 33⅓%; for tiny ones, padding and the prefix make it proportionally larger. In email, MIME also splits Base64 into lines of at most 76 characters, which adds line breaks on top.`,
  ),
  entry(
    "Does gzip or Brotli cancel out that overhead?",
    `They can win back much of it. Base64 carries only 6 bits of information in each 8-bit character, and general-purpose compressors exploit that slack; how much they recover depends on the image data, the compressor and its settings. Compare compressed responses, not character counts.

Some costs remain either way: the image can't be cached apart from the HTML or CSS that carries it, and the browser has to decompress and decode the text. Where nothing compresses the transfer, as in many email pipelines, you pay the full overhead. The lengths shown here are data URI lengths, not network sizes.`,
  ),
  entry(
    "When should I use a separate image file instead of a data URI?",
    `Inline what is small, stable and needed immediately: an icon, a placeholder, images in a self-contained HTML file or a JSON payload. Use separate files for anything large, shared between pages or updated often. An inlined image can't be cached as its own resource, and its bytes travel with the containing document even when the image is lazy-loaded; every change to that file sends it again.

There is no universal size cutoff. HTTP/2 and HTTP/3 made small extra requests cheaper, so inlining to save a request matters less than it used to, but latency and cache reuse still count. Measure for your pages.`,
  ),
  entry(
    "How can I make a Base64 image smaller?",
    `Start with the pixels: halving both dimensions cuts the pixel count to about a quarter, at the cost of detail. Then choose the format: WebP for photos and illustrations, a lossless or reduced-palette PNG for logos, screenshots and pixel art, cleaned-up markup for SVG.

Auto mode does the comparison for you. It encodes each eligible format (lossless PNG up to 4 million pixels, JPEG only for opaque images) and keeps the shortest data URI, prefix and padding included. The built-in 240 × 160 example drops from 4,190 to 2,006 characters with an optimized PNG; that's one test image, not a promise.`,
  ),
  entry(
    "Why did the compressed version come out bigger?",
    `Usually because the source was already efficient. Tiny images are dominated by file headers, well-optimized PNGs leave little to gain, and switching formats can go the wrong way: a photo saved as lossless PNG, or a flat logo saved as JPEG. Re-encoding can't recover detail lost in an earlier JPEG conversion, and may add new artifacts.

At unchanged dimensions, Auto keeps the original when no candidate produces a shorter data URI. When you force a format or change the size, the tool shows the increase in red instead of hiding it.`,
  ),
  entry(
    "PNG, WebP, AVIF or JPEG: which one for an inline image?",
    `Try WebP first for photos and illustrations; it also supports transparency. [Google's 2011 study](https://developers.google.com/speed/webp/docs/webp_study) found WebP files 25–34% smaller than JPEG at comparable SSIM quality on its test sets; today's browser encoders and your own image can differ. Try AVIF too when your browser can encode it. PNG is usually the one to beat for sharp text, flat colors and pixel art, especially with a reduced palette. JPEG suits opaque photos when compatibility matters most, and can't keep transparency: this tool fills transparent areas with a color you pick.

A browser that displays a format can't always encode it, so AVIF only appears here when yours can.`,
  ),
  entry(
    "Does an SVG data URI have to use Base64?",
    `No. SVG is text, so \`data:image/svg+xml,%3Csvg ...%3E\` with URL encoding is valid and often shorter than Base64, whose payload overhead approaches a third. Encode at least \`%\`, \`#\` (as \`%23\`), \`<\`, \`>\` and double quotes.

This tool reads both forms, but the data URI it copies is always Base64. For SVG its real value is the cleanup: removing editor metadata, comments and unnecessary whitespace shortens either encoding while the image stays vector. Optional coordinate rounding shortens it further, but can move fine geometry.`,
  ),
  entry(
    "Will a Base64 image show up in an HTML email?",
    `Don't count on it. Support for images embedded as \`data:\` URIs is patchy across email clients, and several widely used ones block or strip them. Hosted HTTPS images, or MIME attachments referenced with a Content-ID (\`<img src="cid:logo">\`), are the usual alternatives, each with its own caveats: many clients hold back remote images until the reader allows them.

A MIME attachment encoded in Base64 is not the same thing as a data URI in the HTML. This tool can shrink the image and show its size, but it can't test deliverability: send a test to the clients your readers actually use.`,
  ),
  entry(
    "Why does my website block a valid data URI image?",
    `Most likely a Content Security Policy. A directive such as \`img-src 'self'\` refuses \`data:\` URLs, so the image never loads and the browser console names the violated directive. If there is no \`img-src\`, \`default-src\` applies instead.

Add \`data:\` to the directive that governs the image, for example \`img-src 'self' data:\`, if that fits your site's policy, or serve the image as a regular file. Keep it to images: \`data:\` in \`script-src\` can let injected markup run code. And don't switch CSP off to fix one image.`,
  ),
  entry(
    "Why won't my Base64 string decode?",
    `The usual suspects: the string was cut while copying (a payload whose length, without padding, leaves one character over a multiple of 4 is a giveaway), it still carries JSON escapes such as \`\\/\` instead of \`/\` or a literal \`\\n\`, it was URL-encoded (\`%2B\` for \`+\`), or a binary image data URI lacks \`;base64\`.

This tool strips spaces, line breaks, quotes and \`url(...)\` wrappers, accepts the URL-safe alphabet (\`-\` and \`_\`), and selects the first character it can't read. Paste the image value rather than a whole JSON object. Valid Base64 can still hold a truncated file or something that isn't an image.`,
  ),
  entry(
    "Can I tell the image format from the first characters?",
    `Often, as a hint: a PNG's Base64 starts with \`iVBORw0KGgo\`, a JPEG's with \`/9j/\`, a GIF's with \`R0lGOD\`. The prefix isn't proof, though. \`UklGR\` only means a RIFF container, which WebP shares with WAV and AVI, and an SVG can begin with an XML declaration, a comment or whitespace. That's why this tool checks the decoded bytes.`,
    {
      html: signatureTable,
      text: `Common prefixes: ${SIGNATURES.map(([format, prefix]) => `${format}, ${prefix}`).join("; ")}.`,
    },
  ),
  entry(
    "Does compression change quality, animation or metadata?",
    `It can. Lower quality, fewer palette colors and smaller dimensions all remove detail, and Auto may pick a lossy format. The lossless PNG path keeps the pixels the browser decoded, not the original file's structure, metadata or color profile; canvas decoding can also nudge colors, through color conversion and rounding on semi-transparent pixels.

Re-encoding an animated GIF, WebP or PNG keeps a single frame, and the tool warns you when that happens. SVG cleanup rewrites the markup, and rounding coordinates can move fine geometry. When the exact file matters, copy or download the original.`,
  ),
  entry(
    "Is my image uploaded? Is there a size limit?",
    `Nothing is uploaded: decoding, previews and compression run in your browser, with the heavy lifting in a background worker, and no account is needed. Once the page and its worker have loaded, processing works offline.

Image files up to 25 MB can be imported. Very large images still need memory to decode, so a big photo can take a few seconds to compress. Keep in mind that a copied data URI puts the whole image on your clipboard, and embedding it in a public page publishes it.`,
  ),
];
