/**
 * Minimal PNG encoder: palette (1–8 bits) and 8-bit grey/RGB(A) images with adaptive row filters.
 * Compression is injected so the same code runs with CompressionStream (browser) or node:zlib (tests).
 */

/** Must return zlib-wrapped deflate data, as PNG's IDAT expects. */
export type Deflate = (data: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>;

export interface IndexedImage {
  /** RGBA entries, 4 bytes each. */
  readonly palette: Uint8Array;
  readonly indices: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function header(width: number, height: number, bitDepth: number, colorType: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  return data;
}

function assemble(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(SIGNATURE.length + chunks.reduce((total, c) => total + c.length, 0));
  out.set(SIGNATURE);
  let offset = SIGNATURE.length;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export async function encodeIndexedPng(
  width: number,
  height: number,
  { palette, indices }: IndexedImage,
  deflate: Deflate,
): Promise<Uint8Array<ArrayBuffer>> {
  const count = palette.length / 4;
  if (count < 1 || count > 256) throw new RangeError(`Palette of ${count} colors (expected 1 to 256)`);

  // Translucent entries first keeps the tRNS chunk as short as possible.
  const order = Array.from({ length: count }, (_, i) => i).sort(
    (a, b) => Number(palette[b * 4 + 3]! < 255) - Number(palette[a * 4 + 3]! < 255),
  );
  const remap = new Uint8Array(count);
  order.forEach((from, to) => (remap[from] = to));

  const plte = new Uint8Array(count * 3);
  let translucent = 0;
  order.forEach((from, to) => {
    plte.set(palette.subarray(from * 4, from * 4 + 3), to * 3);
    if (palette[from * 4 + 3]! < 255) translucent = to + 1;
  });

  const bitDepth = count <= 2 ? 1 : count <= 4 ? 2 : count <= 16 ? 4 : 8;
  const perByte = 8 / bitDepth;
  const rowBytes = Math.ceil(width / perByte);
  // Filter type 0 (None) for every row: the PNG spec's advice for palette images.
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x++) {
      const shift = 8 - bitDepth * ((x % perByte) + 1);
      raw[row + Math.floor(x / perByte)]! |= remap[indices[y * width + x]!]! << shift;
    }
  }

  const chunks = [chunk("IHDR", header(width, height, bitDepth, 3)), chunk("PLTE", plte)];
  if (translucent > 0) {
    chunks.push(chunk("tRNS", Uint8Array.from(order.slice(0, translucent), (from) => palette[from * 4 + 3]!)));
  }
  chunks.push(chunk("IDAT", await deflate(raw)), chunk("IEND", new Uint8Array(0)));
  return assemble(chunks);
}

/** Encodes RGBA pixels with the smallest lossless colour type: grey, grey + alpha, RGB or RGBA. */
export async function encodeTruecolorPng(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
  deflate: Deflate,
): Promise<Uint8Array<ArrayBuffer>> {
  let opaque = true;
  let grey = true;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]! < 255) opaque = false;
    if (rgba[i + 3]! > 0 && (rgba[i] !== rgba[i + 1] || rgba[i] !== rgba[i + 2])) grey = false;
  }
  const colorType = grey ? (opaque ? 0 : 4) : opaque ? 2 : 6;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]!;
  const stride = width * channels;

  const pixels = new Uint8Array(stride * height);
  for (let p = 0, o = 0; p < rgba.length; p += 4) {
    // Colour under full transparency is invisible: zero it so it compresses better.
    const hidden = rgba[p + 3] === 0;
    if (grey) pixels[o++] = hidden ? 0 : rgba[p]!;
    else {
      pixels[o++] = hidden ? 0 : rgba[p]!;
      pixels[o++] = hidden ? 0 : rgba[p + 1]!;
      pixels[o++] = hidden ? 0 : rgba[p + 2]!;
    }
    if (!opaque) pixels[o++] = rgba[p + 3]!;
  }

  const raw = new Uint8Array((stride + 1) * height);
  const candidates = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const empty = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const current = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : empty;
    let best = 0;
    let bestScore = Infinity;
    for (let filter = 0; filter < 5; filter++) {
      const out = candidates[filter]!;
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? current[x - channels]! : 0;
        const up = previous[x]!;
        const upLeft = x >= channels ? previous[x - channels]! : 0;
        const predictor =
          filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        const value = (current[x]! - predictor) & 0xff;
        out[x] = value;
        score += value < 128 ? value : 256 - value;
      }
      if (score < bestScore) {
        bestScore = score;
        best = filter;
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(candidates[best]!, y * (stride + 1) + 1);
  }

  return assemble([
    chunk("IHDR", header(width, height, 8, colorType)),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
