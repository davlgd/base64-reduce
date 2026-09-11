# Base64 Reduce

Decode a Base64 image, look at it, and get a shorter data URI back. **Everything runs in your browser: the image is never uploaded.**

Paste a Base64 string or a data URI, or open an image file. The tool shows its format, dimensions and size, then re-encodes it right away as WebP, AVIF, PNG or cleaned-up SVG.

You compare the result with the original on a checkerboard, and copy the new data URI when it is worth it. Compression runs in a Web Worker with `OffscreenCanvas` and `CompressionStream`.

## What it does to real inputs

The built-in example is a 240 × 160 PNG illustration with a transparent sky. Auto mode also tries WebP, 3,943 characters at quality 80, and keeps a lossless PNG instead:

```text
before   data:image/png;base64,iVBORw0KGgo…   4,190 characters
after    data:image/png;base64,iVBORw0KGgo…   2,006 characters, 52% smaller
```

An SVG exported by Inkscape carries a namespace, RDF metadata and six-decimal coordinates. Its data URI is 854 characters long, metadata shortened here:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- Created with Inkscape -->
<svg width="120.000000" height="80.000000" viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" inkscape:version="1.3">
  <metadata>…</metadata>
  <g inkscape:label="Calque 1">
    <circle cx="60.000000" cy="40.000000" r="30.123456" fill="#3242c8" />
    <path d="M 10.000000 70.000000 L 110.000000 70.000000 L 60.000000 10.000000 Z" fill="#f4b740" opacity="0.800000" />
  </g>
</svg>
```

With the default settings, it comes out at 306 characters and stays vector:

```xml
<svg width="120" height="80" viewBox="0 0 120 80" xmlns="http://www.w3.org/2000/svg"><g><circle cx="60" cy="40" r="30.123" fill="#3242c8"/><path d="M10 70L110 70L60 10Z" fill="#f4b740" opacity=".8"/></g></svg>
```

An image that is already well compressed may not shrink at all. The tool then says so, instead of handing back something longer.

## Why it exists

Data URIs are everywhere: icons in CSS, logos in HTML emails, thumbnails in JSON. They weigh a third more than the file they encode, and nobody optimizes them where they live.

"Base64 to image" sites decode and stop. Image compressors optimize file size, which is not quite the number that matters once the result is pasted back into a stylesheet.

This tool ranks candidates by the length of the whole data URI, MIME prefix and padding included. A 101-byte PNG gives 158 characters and a 100-byte WebP gives 159, because `image/webp` is one character longer.

## How it works

### Input

Raw Base64 and full data URIs both work, as do values copied from CSS `url(...)` or JSON, line breaks and the URL-safe alphabet. SVG data URIs can be Base64 or URL-encoded.

The format comes from the decoded bytes, not from the prefix: PNG, JPEG, GIF, WebP, AVIF, SVG, BMP or ICO. When the string is broken, the error points at the first character that can't be decoded.

### Output

Auto mode encodes every format that makes sense for the image and keeps the shortest data URI. JPEG is only tried on opaque images, lossless PNG up to 4 million pixels.

| Output | Method | Lossless |
| --- | --- | --- |
| PNG | Own encoder: a palette for 256 colors or fewer, otherwise the smallest color type and the best row filter. The browser's PNG wins if shorter. | Yes |
| PNG, fewer colors | Median-cut palette refined by k-means, optional Floyd–Steinberg dithering. | No |
| WebP, AVIF, JPEG | The browser's encoders, through `OffscreenCanvas.convertToBlob`. | No |
| SVG | Drops the prolog, comments, editor metadata and whitespace, shortens numbers, rounds to 3 decimals by default. | With rounding off |

The SVG minifier stays conservative. Path data goes through a tokenizer that knows each command's arity, so compact arc flags such as `a10 10 0 0110 10` stay intact.

Settings let you force a format and change the quality, size or number of PNG colors. Re-encoding keeps only the first frame of an animation and drops metadata; the page warns about animated images.

## Run it

Requires [Bun](https://bun.com) 1.3 or later. On the browser side: Chrome or Edge 119, Firefox 121 or Safari 17.4.

```shell
bun install
bun run start   # production, on 0.0.0.0:8080
bun run dev     # rebuilds on server and client changes
```

Override the port and the public URL, used for the canonical link, Open Graph and the sitemap, through environment variables:

```shell
PORT=3000 SITE_URL=https://example.com bun run start
```

## Develop

```shell
bun test            # decoder, PNG round trips, quantizer, SVG minifier, HTTP
bun run typecheck   # TypeScript 7: server with Bun types, client with the DOM
bun run check       # both
```

The server is plain `Bun.serve`. At startup, it bundles the client and the worker in memory with `Bun.build`, then prepares every response once with hashed names, ETags, Brotli and gzip.

The page ships a strict Content Security Policy that allows its inline stylesheet by hash. Its copy, FAQ, structured data and `llms.txt` all come from a single file, `src/site/content.ts`.

| Path | Role |
| --- | --- |
| `src/server.ts` | Routes, headers, client rebuilds in dev mode |
| `src/bundle.ts` | In-memory client build, fonts, public files |
| `src/http.ts` | Prepared responses: ETags, compression, HEAD, 304 |
| `src/site/` | Page, FAQ, structured data, robots.txt, sitemap, llms.txt |
| `src/client/app.ts` | Browser entry point: Base64 field and decoding |
| `src/client/compression-panel.ts` | Compression settings and result |
| `src/client/reduce-worker.ts` | Compression worker |
| `src/client/png.ts` | PNG encoder |
| `src/client/quantize.ts` | Palette reduction |
| `src/client/svg.ts` | SVG minifier |
| `test/` | Bun tests |

## License

Apache 2.0 — see [LICENSE](./LICENSE).
