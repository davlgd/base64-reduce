/**
 * Parsing and format detection for Base64-encoded images.
 * Pure functions: they run in the browser and under `bun test`.
 */
import { FORMATS, type ImageFormat } from "./formats.ts";

export type DecodeError =
  | { readonly kind: "empty" }
  | { readonly kind: "not-base64-uri" }
  /** `index` is the offset of the offending character in the original input. */
  | { readonly kind: "invalid-char"; readonly char: string; readonly index: number }
  | { readonly kind: "bad-padding"; readonly index: number }
  | { readonly kind: "bad-length" }
  | { readonly kind: "unknown-format" };

export interface DecodedImage {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly format: ImageFormat;
  /** Standard-alphabet, padded Base64, ready to be put back in a data URI. */
  readonly base64: string;
  /** MIME type announced by the data URI, if any. */
  readonly declaredMime: string | null;
}

export type DecodeResult =
  | { readonly ok: true; readonly image: DecodedImage }
  | { readonly ok: false; readonly error: DecodeError };

const DATA_URI_HEAD = /^data:([^,]{0,200}),/i;
const WHITESPACE = /\s+/g;
const VALID_COMPACT = /^[A-Za-z0-9+/_-]*={0,2}$/;
const ALPHABET = /[A-Za-z0-9+/_-]/;
const SPACE = /\s/;

export function decodeImage(input: string): DecodeResult {
  let [start, end] = unwrap(input);
  if (start === end) return fail({ kind: "empty" });

  let declaredMime: string | null = null;
  const head = DATA_URI_HEAD.exec(input.slice(start, end));
  if (head) {
    const params = (head[1] ?? "").split(";").map((part) => part.trim().toLowerCase());
    declaredMime = params[0] || null;
    start += head[0].length;
    if (!params.includes("base64")) {
      // SVG is often inlined as percent-encoded text rather than Base64.
      return declaredMime === "image/svg+xml" ? decodeTextSvg(input.slice(start, end)) : fail({ kind: "not-base64-uri" });
    }
  }

  const compact = input.slice(start, end).replace(WHITESPACE, "");
  if (compact === "") return fail({ kind: "empty" });
  if (!VALID_COMPACT.test(compact)) return fail(locateError(input, start, end));

  const body = compact.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
  if (body.length % 4 === 1) return fail({ kind: "bad-length" });
  const base64 = body + "=".repeat((4 - (body.length % 4)) % 4);

  const bytes = base64ToBytes(base64);
  const format = detectFormat(bytes) ?? formatFromMime(declaredMime);
  if (!format) return fail({ kind: "unknown-format" });

  return { ok: true, image: { bytes, format, base64, declaredMime } };
}

function decodeTextSvg(payload: string): DecodeResult {
  let text: string;
  try {
    text = decodeURIComponent(payload);
  } catch {
    return fail({ kind: "not-base64-uri" });
  }
  const bytes = new TextEncoder().encode(text);
  if (!looksLikeSvg(bytes)) return fail({ kind: "unknown-format" });
  return { ok: true, image: { bytes, format: FORMATS.svg, base64: bytesToBase64(bytes), declaredMime: "image/svg+xml" } };
}

/** Identifies an image from its leading bytes ("magic numbers"). */
export function detectFormat(bytes: Uint8Array): ImageFormat | null {
  const at = (offset: number, ...expected: number[]) =>
    expected.every((byte, i) => bytes[offset + i] === byte);
  const text = (offset: number, value: string) =>
    at(offset, ...Array.from(value, (c) => c.charCodeAt(0)));

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return FORMATS.png;
  if (at(0, 0xff, 0xd8, 0xff)) return FORMATS.jpeg;
  if (text(0, "GIF87a") || text(0, "GIF89a")) return FORMATS.gif;
  if (text(0, "RIFF") && text(8, "WEBP")) return FORMATS.webp;
  if (text(4, "ftyp") && (text(8, "avif") || text(8, "avis"))) return FORMATS.avif;
  if (text(0, "BM") && bytes.length > 26) return FORMATS.bmp;
  if (at(0, 0x00, 0x00, 0x01, 0x00) && bytes.length > 6) return FORMATS.ico;
  if (looksLikeSvg(bytes)) return FORMATS.svg;
  return null;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 4096)).trimStart();
  return head.startsWith("<") && /<svg[\s>]/i.test(head);
}

function formatFromMime(mime: string | null): ImageFormat | null {
  if (!mime?.startsWith("image/")) return null;
  const aliases: Record<string, string> = { "image/jpg": "image/jpeg", "image/vnd.microsoft.icon": "image/x-icon" };
  const normalized = aliases[mime] ?? mime;
  const known = Object.values(FORMATS).find((format) => format.mime === normalized);
  if (known) return known;
  const subtype = normalized.slice("image/".length).replace(/\+.*$/, "");
  return { label: subtype.toUpperCase(), mime: normalized, extension: subtype, raster: true };
}

/** Skips surrounding whitespace, quotes and CSS `url(...)`, as copied from HTML, CSS or JSON. */
function unwrap(input: string): [number, number] {
  let start = 0;
  let end = input.length;
  const trim = () => {
    while (start < end && SPACE.test(input[start]!)) start++;
    while (end > start && SPACE.test(input[end - 1]!)) end--;
  };
  trim();
  for (let changed = true; changed && start < end; ) {
    changed = false;
    if (input.slice(start, start + 4).toLowerCase() === "url(" && input[end - 1] === ")") {
      start += 4;
      end -= 1;
      changed = true;
    }
    const first = input[start];
    if ((first === '"' || first === "'") && end - start >= 2 && input[end - 1] === first) {
      start += 1;
      end -= 1;
      changed = true;
    }
    trim();
  }
  return [start, end];
}

/** Slow path, only taken for invalid input: finds the first offending character. */
function locateError(input: string, start: number, end: number): DecodeError {
  let padding = 0;
  let firstPadding = -1;
  for (let i = start; i < end; ) {
    const char = String.fromCodePoint(input.codePointAt(i)!);
    if (SPACE.test(char)) {
      i += char.length;
      continue;
    }
    if (char === "=") {
      if (padding++ === 0) firstPadding = i;
      if (padding > 2) return { kind: "bad-padding", index: i };
    } else if (!ALPHABET.test(char)) {
      return { kind: "invalid-char", char, index: i };
    } else if (padding > 0) {
      return { kind: "bad-padding", index: firstPadding };
    }
    i += char.length;
  }
  return { kind: "bad-padding", index: end - 1 };
}

// Native Uint8Array Base64 methods where available (Bun, current browsers), atob/btoa elsewhere.

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function fail(error: DecodeError): DecodeResult {
  return { ok: false, error };
}
