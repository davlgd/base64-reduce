import { describe, expect, test } from "bun:test";
import { decodeImage, detectFormat } from "../src/client/decode.ts";
import { FORMATS } from "../src/client/formats.ts";
import { describeChange, formatBytes } from "../src/client/format.ts";
import { SAMPLE_DATA_URI } from "../src/client/sample.ts";

/** 1 × 1 transparent PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>').toString("base64");

function decoded(input: string) {
  const result = decodeImage(input);
  if (!result.ok) throw new Error(`unexpected failure: ${JSON.stringify(result.error)}`);
  return result.image;
}

function error(input: string) {
  const result = decodeImage(input);
  if (result.ok) throw new Error("unexpected success");
  return result.error;
}

describe("decodeImage", () => {
  test("decodes raw Base64", () => {
    const image = decoded(PNG);
    expect(image.format).toBe(FORMATS.png);
    expect(image.bytes.byteLength).toBe(68);
    expect(image.base64).toBe(PNG);
    expect(image.declaredMime).toBeNull();
  });

  test("decodes a data URI and keeps the declared MIME type", () => {
    const image = decoded(`data:image/png;base64,${PNG}`);
    expect(image.format).toBe(FORMATS.png);
    expect(image.declaredMime).toBe("image/png");
  });

  test("trusts the bytes over a wrong declared MIME type", () => {
    expect(decoded(`data:image/jpeg;base64,${PNG}`).format).toBe(FORMATS.png);
  });

  test("ignores whitespace, line breaks, quotes and CSS url()", () => {
    const wrapped = PNG.match(/.{1,20}/g)!.join("\n  ");
    expect(decoded(`  \n${wrapped}\n`).base64).toBe(PNG);
    expect(decoded(`"${PNG}"`).base64).toBe(PNG);
    expect(decoded(`url("data:image/png;base64,${PNG}")`).base64).toBe(PNG);
    expect(decoded(`url( 'data:image/png;base64,${PNG}' )`).base64).toBe(PNG);
  });

  test("accepts URL-safe Base64 and missing padding", () => {
    const standard = decoded(SVG).base64;
    const urlSafe = standard.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    expect(decoded(urlSafe).base64).toBe(standard);
    expect(decoded(PNG.replace(/=+$/, "")).base64).toBe(PNG);
  });

  test("detects SVG, including with an XML prolog", () => {
    expect(decoded(SVG).format).toBe(FORMATS.svg);
    expect(decoded(`data:image/svg+xml;base64,${btoa("<svg></svg>")}`).format).toBe(FORMATS.svg);
  });

  test("falls back on the declared MIME type for unrecognised image bytes", () => {
    const image = decoded(`data:image/tiff;base64,${btoa("II*\u0000rest")}`);
    expect(image.format.mime).toBe("image/tiff");
    expect(image.format.extension).toBe("tiff");
  });

  test("decodes the bundled sample", () => {
    expect(decoded(SAMPLE_DATA_URI).format).toBe(FORMATS.png);
  });

  test("reports empty input", () => {
    expect(error("")).toEqual({ kind: "empty" });
    expect(error("  \n ")).toEqual({ kind: "empty" });
    expect(error("data:image/png;base64,")).toEqual({ kind: "empty" });
  });

  test("points at the first invalid character in the original text", () => {
    const input = `  iVBOR w0K%Ggo`;
    expect(error(input)).toEqual({ kind: "invalid-char", char: "%", index: input.indexOf("%") });
    expect(error("iVBOR😀w0")).toEqual({ kind: "invalid-char", char: "😀", index: 5 });
  });

  test("reports misplaced padding", () => {
    expect(error("iVBO=RwA")).toEqual({ kind: "bad-padding", index: 4 });
    expect(error("iVBORw===")).toEqual({ kind: "bad-padding", index: 8 });
  });

  test("reports truncated input", () => {
    expect(error("iVBORw0KG")).toEqual({ kind: "bad-length" });
  });

  test("rejects valid Base64 that is not an image", () => {
    expect(error(btoa("Bonjour tout le monde"))).toEqual({ kind: "unknown-format" });
  });

  test("accepts percent-encoded SVG data URIs", () => {
    const image = decoded(`data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3C/svg%3E`);
    expect(image.format).toBe(FORMATS.svg);
    expect(new TextDecoder().decode(image.bytes)).toStartWith("<svg xmlns=");
  });

  test("rejects other data URIs that are not Base64-encoded", () => {
    expect(error("data:image/png,%89PNG")).toEqual({ kind: "not-base64-uri" });
  });
});

describe("detectFormat", () => {
  const bytes = (...values: (number | string)[]) =>
    new Uint8Array(values.flatMap((v) => (typeof v === "number" ? [v] : Array.from(v, (c) => c.charCodeAt(0)))));

  test.each([
    ["JPEG", bytes(0xff, 0xd8, 0xff, 0xe0), FORMATS.jpeg],
    ["GIF", bytes("GIF89a"), FORMATS.gif],
    ["WebP", bytes("RIFF", 0, 0, 0, 0, "WEBPVP8 "), FORMATS.webp],
    ["AVIF", bytes(0, 0, 0, 0x1c, "ftypavif"), FORMATS.avif],
    ["BMP", bytes("BM", ...new Array(30).fill(0)), FORMATS.bmp],
    ["ICO", bytes(0, 0, 1, 0, 1, 0, 16, 16), FORMATS.ico],
  ])("%s", (_, input, expected) => {
    expect(detectFormat(input)).toBe(expected);
  });

  test("returns null for unknown bytes", () => {
    expect(detectFormat(bytes("hello"))).toBeNull();
  });
});

describe("formatting", () => {
  test("formats sizes with decimal units", () => {
    expect(formatBytes(1)).toBe("1\u00a0byte");
    expect(formatBytes(512)).toBe("512\u00a0bytes");
    expect(formatBytes(12_345)).toBe("12.3\u00a0kB");
    expect(formatBytes(4_200_000)).toBe("4.2\u00a0MB");
  });

  test("describes a length change", () => {
    expect(describeChange(4190, 2006)).toEqual({ text: "52% smaller", trend: "down" });
    expect(describeChange(1000, 1120)).toEqual({ text: "12% larger", trend: "up" });
    expect(describeChange(1000, 1000)).toEqual({ text: "Same size", trend: "flat" });
    // Rounding must never hide the direction of a change.
    expect(describeChange(10000, 10001)).toEqual({ text: "<1% larger", trend: "up" });
    expect(describeChange(10000, 9999)).toEqual({ text: "<1% smaller", trend: "down" });
  });
});
