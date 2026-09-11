/**
 * Compression worker: resizes the source bitmap and encodes it with the browser's native
 * encoders (WebP, AVIF, JPEG) or our PNG encoder, off the main thread.
 */
import { dataUriLength, FORMATS, type RasterFormat } from "./formats.ts";
import { encodeIndexedPng, encodeTruecolorPng, type Deflate } from "./png.ts";
import { extractPalette, quantize } from "./quantize.ts";
import type { RasterSettings, WorkerRequest, WorkerResponse } from "./reduce-protocol.ts";

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly canvas: OffscreenCanvas;
  readonly pixels: ImageData;
  readonly opaque: boolean;
}

const scope = globalThis as unknown as WorkerScope;
/** Lossless PNG is slow on big photos and rarely the shortest there: Auto skips it above this size. */
const AUTO_PNG_MAX_PIXELS = 4_000_000;

const deflate: Deflate = async (data) => {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

let source: ImageBitmap | null = null;
let frame: Frame | null = null;
const supported = detectFormats();

async function detectFormats(): Promise<Set<RasterFormat>> {
  const probe = new OffscreenCanvas(1, 1);
  probe.getContext("2d");
  const formats = new Set<RasterFormat>(["png"]);
  for (const format of ["webp", "avif", "jpeg"] as const) {
    const blob = await probe.convertToBlob({ type: FORMATS[format].mime }).catch(() => null);
    if (blob?.type === FORMATS[format].mime) formats.add(format);
  }
  return formats;
}

function context2d(canvas: OffscreenCanvas, options?: CanvasRenderingContext2DSettings): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d", options);
  if (!context) throw new Error("no 2D canvas context");
  return context;
}

async function frameFor(width: number, height: number): Promise<Frame> {
  if (!source) throw new Error("no source image");
  if (frame?.width === width && frame.height === height) return frame;
  const resized =
    width === source.width && height === source.height
      ? source
      : await createImageBitmap(source, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  const canvas = new OffscreenCanvas(width, height);
  const context = context2d(canvas, { willReadFrequently: true });
  context.drawImage(resized, 0, 0);
  if (resized !== source) resized.close();
  const pixels = context.getImageData(0, 0, width, height);
  let opaque = true;
  for (let i = 3; i < pixels.data.length; i += 4) {
    if (pixels.data[i]! < 255) {
      opaque = false;
      break;
    }
  }
  frame = { width, height, canvas, pixels, opaque };
  return frame;
}

/** Encodes with the browser; null when it silently falls back to another type (unsupported format). */
async function native(canvas: OffscreenCanvas, format: RasterFormat, quality?: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const { mime } = FORMATS[format];
  const blob = await canvas.convertToBlob(quality === undefined ? { type: mime } : { type: mime, quality });
  return blob.type === mime ? new Uint8Array(await blob.arrayBuffer()) : null;
}

async function encodeAs(format: RasterFormat, f: Frame, settings: RasterSettings): Promise<Uint8Array<ArrayBuffer> | null> {
  const quality = settings.quality / 100;
  switch (format) {
    case "webp":
    case "avif":
      return native(f.canvas, format, quality);
    case "jpeg": {
      if (f.opaque) return native(f.canvas, "jpeg", quality);
      const flat = new OffscreenCanvas(f.width, f.height);
      const context = context2d(flat);
      context.fillStyle = settings.background;
      context.fillRect(0, 0, f.width, f.height);
      context.drawImage(f.canvas, 0, 0);
      return native(flat, "jpeg", quality);
    }
    case "png": {
      const data = f.pixels.data;
      if (settings.colors > 0) {
        return encodeIndexedPng(f.width, f.height, quantize(data, f.width, settings.colors, settings.dither), deflate);
      }
      // Lossless: palette when there are few colours, otherwise the tightest true-colour type,
      // compared with the browser's own PNG encoder.
      const palette = extractPalette(data, 256);
      const options = await Promise.all([
        palette ? encodeIndexedPng(f.width, f.height, palette, deflate) : null,
        encodeTruecolorPng(f.width, f.height, data, deflate),
        native(f.canvas, "png"),
      ]);
      return minBy(options.filter((o) => o !== null), (o) => o.byteLength) ?? null;
    }
  }
}

function minBy<T>(items: readonly T[], key: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>((best, item) => (best === undefined || key(item) < key(best) ? item : best), undefined);
}

async function encode(settings: RasterSettings) {
  const formats = await supported;
  const f = await frameFor(settings.width, settings.height);
  const wanted: RasterFormat[] =
    settings.format === "auto"
      ? (["webp", "avif", "jpeg", "png"] as const).filter(
          (format) =>
            formats.has(format) &&
            // JPEG would flatten transparency: only when there is none.
            (format !== "jpeg" || f.opaque) &&
            (format !== "png" || f.width * f.height <= AUTO_PNG_MAX_PIXELS),
        )
      : [settings.format];

  const results: { format: RasterFormat; bytes: Uint8Array<ArrayBuffer> }[] = [];
  for (const format of wanted) {
    const bytes = await encodeAs(format, f, settings);
    if (bytes) results.push({ format, bytes });
  }
  // Ranked by data URI length, not file size: the MIME prefix and Base64 padding can flip close calls.
  const best = minBy(results, (r) => dataUriLength(FORMATS[r.format].mime, r.bytes.byteLength));
  if (!best) throw new Error("the browser can't encode this format");
  return { format: best.format, bytes: best.bytes, width: f.width, height: f.height, tried: results.length };
}

scope.onmessage = async ({ data }) => {
  if (data.type === "source") {
    source?.close();
    source = data.bitmap;
    frame = null;
    return;
  }
  try {
    const result = await encode(data.settings);
    scope.postMessage({ type: "result", id: data.id, ...result }, [result.bytes.buffer]);
  } catch (error) {
    scope.postMessage({ type: "error", id: data.id, message: error instanceof Error ? error.message : String(error) });
  }
};

supported.then((formats) => scope.postMessage({ type: "capabilities", formats: [...formats] }));
