import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { bytesToBase64, decodeImage } from "../src/client/decode.ts";
import { FORMATS } from "../src/client/formats.ts";
import { isAnimated } from "../src/client/inspect.ts";
import { encodeIndexedPng, encodeTruecolorPng, type Deflate } from "../src/client/png.ts";
import { extractPalette, quantize } from "../src/client/quantize.ts";
import { minifySvg } from "../src/client/svg.ts";

const deflate: Deflate = async (data) => new Uint8Array(deflateSync(data));

/** Test-only PNG decoder: returns RGBA pixels, enough to check our encoder round-trips. */
function decodePng(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  let palette: Uint8Array = new Uint8Array(0);
  let alpha: Uint8Array = new Uint8Array(0);
  const idat: Uint8Array[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") alpha = data;
    else if (type === "IDAT") idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]!;
  const bpp = Math.max(1, (channels * bitDepth) / 8);
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const row = Uint8Array.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const up = rows[y - 1] ?? new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp]! : 0;
      const b = up[x]!;
      const c = x >= bpp ? up[x - bpp]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      row[x] = (row[x]! + [0, a, b, (a + b) >> 1, paeth][filter]!) & 0xff;
    }
    rows.push(row);
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const row = rows[y]!;
      if (colorType === 3) {
        const perByte = 8 / bitDepth;
        const index = (row[Math.floor(x / perByte)]! >> (8 - bitDepth * ((x % perByte) + 1))) & ((1 << bitDepth) - 1);
        rgba.set(palette.subarray(index * 3, index * 3 + 3), o);
        rgba[o + 3] = index < alpha.length ? alpha[index]! : 255;
      } else {
        const px = row.subarray(x * channels, (x + 1) * channels);
        const grey = colorType === 0 || colorType === 4;
        rgba[o] = px[0]!;
        rgba[o + 1] = grey ? px[0]! : px[1]!;
        rgba[o + 2] = grey ? px[0]! : px[2]!;
        rgba[o + 3] = colorType === 4 ? px[1]! : colorType === 6 ? px[3]! : 255;
      }
    }
  }
  return { width, height, bitDepth, colorType, rgba };
}

/** Deterministic test image: a gradient with a transparent band. */
function gradient(width: number, height: number, transparent = true): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = (x * 255) / (width - 1);
      rgba[o + 1] = (y * 255) / (height - 1);
      rgba[o + 2] = 128;
      rgba[o + 3] = transparent && y < 2 ? 0 : 255;
    }
  }
  return rgba;
}

describe("PNG encoder", () => {
  test("true colour round-trips losslessly with alpha", async () => {
    const pixels = gradient(17, 9);
    const decoded = decodePng(await encodeTruecolorPng(17, 9, pixels, deflate));
    expect(decoded.colorType).toBe(6);
    // Visible pixels are identical; hidden ones have their colour zeroed.
    const expected = Uint8Array.from(pixels);
    for (let i = 3; i < expected.length; i += 4) if (expected[i] === 0) expected.fill(0, i - 3, i);
    expect([...decoded.rgba]).toEqual([...expected]);
  });

  test("drops the alpha channel and colour when they are unused", async () => {
    const opaque = gradient(8, 8, false);
    expect(decodePng(await encodeTruecolorPng(8, 8, opaque, deflate)).colorType).toBe(2);
    const grey = Uint8Array.from({ length: 64 }, (_, i) => (i % 4 === 3 ? 255 : 90));
    expect(decodePng(await encodeTruecolorPng(4, 4, grey, deflate)).colorType).toBe(0);
  });

  test("zeroes colour under full transparency", async () => {
    const pixels = Uint8Array.from([200, 10, 30, 0, 1, 2, 3, 255]);
    const decoded = decodePng(await encodeTruecolorPng(2, 1, pixels, deflate));
    expect([...decoded.rgba]).toEqual([0, 0, 0, 0, 1, 2, 3, 255]);
  });

  test.each([
    [2, 1],
    [4, 2],
    [16, 4],
    [200, 8],
  ])("palette of %i colours uses %i-bit indices and round-trips", async (count, bitDepth) => {
    const width = 13;
    const height = Math.ceil(count / width) + 1;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const c = i % count;
      pixels.set([c, 255 - c, (c * 7) % 256, c === 0 ? 0 : 255], i * 4);
    }
    const palette = extractPalette(pixels)!;
    const png = await encodeIndexedPng(width, height, palette, deflate);
    const decoded = decodePng(png);
    expect(decoded.colorType).toBe(3);
    expect(decoded.bitDepth).toBe(bitDepth);
    const expected = Uint8Array.from(pixels);
    for (let i = 3; i < expected.length; i += 4) if (expected[i] === 0) expected.fill(0, i - 3, i);
    expect([...decoded.rgba]).toEqual([...expected]);
    expect(decodeImage(`data:image/png;base64,${bytesToBase64(png)}`).ok).toBe(true);
  });
});

describe("quantize", () => {
  test("keeps an exact palette when colours already fit", () => {
    const pixels = gradient(4, 4, false);
    const result = quantize(pixels, 4, 256, true);
    expect(result.palette.length / 4).toBe(16);
  });

  test.each([false, true])("reduces to the requested palette size (dither: %p)", (dither) => {
    const pixels = gradient(64, 64);
    const { palette, indices } = quantize(pixels, 64, 16, dither);
    expect(palette.length / 4).toBeLessThanOrEqual(16);
    expect(indices.length).toBe(64 * 64);
    for (const index of indices) expect(index).toBeLessThan(palette.length / 4);
  });

  test("maps fully transparent pixels to a fully transparent entry", () => {
    const pixels = gradient(64, 64);
    const { palette, indices } = quantize(pixels, 64, 8, true);
    const index = indices[0]!;
    expect([...palette.subarray(index * 4, index * 4 + 4)]).toEqual([0, 0, 0, 0]);
    // Opaque rows never pick the transparent entry.
    for (let i = 64 * 2; i < indices.length; i++) expect(palette[indices[i]! * 4 + 3]).toBeGreaterThan(0);
  });

  test("stays close to the source colours", () => {
    const pixels = gradient(32, 32, false);
    const { palette, indices } = quantize(pixels, 32, 64, false);
    let error = 0;
    for (let i = 0; i < indices.length; i++) {
      for (let c = 0; c < 3; c++) error += Math.abs(pixels[i * 4 + c]! - palette[indices[i]! * 4 + c]!);
    }
    expect(error / (indices.length * 3)).toBeLessThan(12);
  });
});

describe("minifySvg", () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Inkscape -->
<svg width="24.000" height="24" viewBox="0 0 24 24"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     inkscape:version="1.3">
  <metadata><rdf:RDF><cc:Work/></rdf:RDF></metadata>
  <sodipodi:namedview id="base" pagecolor="#ffffff"/>
  <path d="M 10.123456 20.5 L 0.500 -0.25 Z" fill="#3242c8" />
  <text x="2" y="20">Bonjour  le   monde</text>
</svg>`;

  test("removes prolog, comments, metadata and editor data", () => {
    const out = minifySvg(source, { precision: null });
    expect(out).not.toMatch(/<\?xml|<!--|metadata|inkscape|sodipodi/);
    expect(out).toStartWith('<svg xmlns="http://www.w3.org/2000/svg"');
  });

  test("compacts numbers and path data, keeping text untouched", () => {
    const out = minifySvg(source, { precision: 3 });
    expect(out).toContain('d="M10.123 20.5L.5-.25Z"');
    expect(out).toContain('width="24"');
    expect(out).toContain("<text x=\"2\" y=\"20\">Bonjour  le   monde</text>");
    expect(out.length).toBeLessThan(source.length / 2);
  });

  test("keeps full precision when rounding is off", () => {
    expect(minifySvg(source, { precision: null })).toContain("M10.123456 20.5");
  });

  test("never reads compact arc flags as numbers", () => {
    const path = (d: string) => minifySvg(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${d}"/></svg>`, { precision: null });
    // Flags 0 and 1 written without separators, followed by x = 10.
    expect(path("M10 10a10 10 0 0110 10")).toContain('d="M10 10a10 10 0 0 1 10 10"');
    expect(path("M0 0 A5 5 0 1 0 .5 .5 Z")).toContain('d="M0 0A5 5 0 1 0 .5.5Z"');
    // Leading zeros elsewhere are plain numbers.
    expect(path("M10 10 Q 0 01 10 10")).toContain('d="M10 10Q0 1 10 10"');
    // Data the tokenizer can't follow is kept as is.
    expect(path("M10 10 X 5")).toContain('d="M10 10 X 5"');
  });

  test("keeps the existing xmlns", () => {
    const out = minifySvg('<svg xmlns="http://www.w3.org/2000/svg"  viewBox="0 0 1 1" ></svg>', { precision: 3 });
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>');
  });
});

describe("isAnimated", () => {
  const gif = (frames: number) => {
    const header = [..."GIF89a"].map((c) => c.charCodeAt(0)).concat([1, 0, 1, 0, 0, 0, 0]);
    const frame = [0x21, 0xf9, 4, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x4c, 0x01, 0];
    return new Uint8Array([...header, ...Array.from({ length: frames }, () => frame).flat(), 0x3b]);
  };

  test("counts GIF frames", () => {
    expect(isAnimated(gif(1), FORMATS.gif)).toBe(false);
    expect(isAnimated(gif(3), FORMATS.gif)).toBe(true);
  });

  test("reads the WebP animation flag", () => {
    const webp = new Uint8Array(32);
    webp.set([..."RIFF"].map((c) => c.charCodeAt(0)), 0);
    webp.set([..."WEBPVP8X"].map((c) => c.charCodeAt(0)), 8);
    expect(isAnimated(webp, FORMATS.webp)).toBe(false);
    webp[20] = 0x02;
    expect(isAnimated(webp, FORMATS.webp)).toBe(true);
  });

  test("finds the APNG acTL chunk before image data", async () => {
    const png = await encodeTruecolorPng(1, 1, new Uint8Array([1, 2, 3, 255]), deflate);
    expect(isAnimated(png, FORMATS.png)).toBe(false);
    const actl = new Uint8Array([0, 0, 0, 8, ..."acTL"].map((v) => (typeof v === "string" ? v.charCodeAt(0) : v)).concat([0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]));
    const apng = new Uint8Array([...png.subarray(0, 33), ...actl, ...png.subarray(33)]);
    expect(isAnimated(apng, FORMATS.png)).toBe(true);
  });
});

test("bytesToBase64 matches Buffer", () => {
  const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 31) % 256);
  expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
});
