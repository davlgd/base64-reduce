/**
 * Colour reduction for palette PNGs: median cut on a 5-bit histogram, k-means refinement,
 * then optional Floyd–Steinberg dithering. Fully transparent pixels always keep a transparent entry.
 */
import type { IndexedImage } from "./png.ts";

type Pixels = Uint8Array | Uint8ClampedArray;

const BITS = 5;
const SHIFT = 8 - BITS;
const KEY_SPACE = 1 << (BITS * 4);
/** Channel weights (R, G, B, A) for colour distance, roughly following perceived brightness. */
const WEIGHTS = [2, 4, 3, 3] as const;
const DITHER_STRENGTH = 0.85;
const MAX_REFINE_WORK = 60_000_000;

/** Exact palette when the image has at most `maxColors` colours (lossless), otherwise null. */
export function extractPalette(rgba: Pixels, maxColors = 256): IndexedImage | null {
  const view = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length / 4);
  const alphaMask = new Uint32Array(new Uint8Array([0, 0, 0, 255]).buffer)[0]!;
  const index = new Map<number, number>();
  const indices = new Uint8Array(view.length);
  for (let i = 0; i < view.length; i++) {
    // Every fully transparent pixel is the same colour once displayed.
    const color = (view[i]! & alphaMask) === 0 ? 0 : view[i]!;
    let slot = index.get(color);
    if (slot === undefined) {
      if (index.size === maxColors) return null;
      slot = index.size;
      index.set(color, slot);
    }
    indices[i] = slot;
  }
  const palette = new Uint8Array(index.size * 4);
  const words = new Uint32Array(palette.buffer);
  for (const [color, slot] of index) words[slot] = color;
  return { palette, indices };
}

export function quantize(rgba: Pixels, width: number, maxColors: number, dither: boolean): IndexedImage {
  const exact = extractPalette(rgba, maxColors);
  if (exact) return exact;

  const pixelCount = rgba.length / 4;
  let hasTransparent = false;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] === 0) {
      hasTransparent = true;
      break;
    }
  }
  const budget = Math.max(1, maxColors - (hasTransparent ? 1 : 0));

  // 1. Histogram of visible pixels, 5 bits per channel.
  const slotOf = new Int32Array(KEY_SPACE).fill(-1);
  const capacity = Math.min(pixelCount, KEY_SPACE);
  const counts = new Float64Array(capacity);
  const sums = new Float64Array(capacity * 4);
  let entries = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    const a = rgba[p + 3]!;
    if (a === 0) continue;
    const key = keyOf(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!, a);
    let slot = slotOf[key]!;
    if (slot < 0) slot = slotOf[key] = entries++;
    counts[slot]!++;
    sums[slot * 4]! += rgba[p]!;
    sums[slot * 4 + 1]! += rgba[p + 1]!;
    sums[slot * 4 + 2]! += rgba[p + 2]!;
    sums[slot * 4 + 3]! += a;
  }
  const colors = new Float64Array(entries * 4);
  for (let s = 0; s < entries; s++) {
    for (let c = 0; c < 4; c++) colors[s * 4 + c] = sums[s * 4 + c]! / counts[s]!;
  }

  // 2. Median cut, 3. k-means refinement.
  let palette = entries > 0 ? medianCut(colors, counts, entries, budget) : new Float64Array(0);
  if (entries * (palette.length / 4) * 3 <= MAX_REFINE_WORK) palette = refine(palette, colors, counts, entries, 3);

  const visible = palette.length / 4;
  const full = new Float64Array((visible + (hasTransparent ? 1 : 0)) * 4);
  full.set(palette);
  const transparentIndex = hasTransparent ? visible : -1;

  // 4. Map pixels, remembering the nearest entry per histogram cell.
  const premultiplied = premultiply(full);
  const cache = new Int16Array(KEY_SPACE).fill(-1);
  const nearest = (r: number, g: number, b: number, a: number): number => {
    const key = keyOf(r, g, b, a);
    let found = cache[key]!;
    if (found < 0) found = cache[key] = nearestIndex(premultiplied, visible, r, g, b, a);
    return found;
  };

  const indices = new Uint8Array(pixelCount);
  if (!dither) {
    for (let i = 0, p = 0; i < pixelCount; i++, p += 4) {
      indices[i] = rgba[p + 3] === 0 ? transparentIndex : nearest(rgba[p]!, rgba[p + 1]!, rgba[p + 2]!, rgba[p + 3]!);
    }
  } else {
    floydSteinberg(rgba, width, full, indices, transparentIndex, nearest);
  }

  return compact(full, indices);
}

function keyOf(r: number, g: number, b: number, a: number): number {
  return ((r >> SHIFT) << 15) | ((g >> SHIFT) << 10) | ((b >> SHIFT) << 5) | (a >> SHIFT);
}

interface Box {
  readonly start: number;
  readonly end: number;
  readonly population: number;
  readonly channel: number;
  readonly score: number;
}

function medianCut(colors: Float64Array, counts: Float64Array, entries: number, target: number): Float64Array {
  const order = Uint32Array.from({ length: entries }, (_, i) => i);
  const describe = (start: number, end: number): Box => {
    const min = [255, 255, 255, 255];
    const max = [0, 0, 0, 0];
    let population = 0;
    for (let i = start; i < end; i++) {
      const s = order[i]!;
      population += counts[s]!;
      for (let c = 0; c < 4; c++) {
        const v = colors[s * 4 + c]!;
        if (v < min[c]!) min[c] = v;
        if (v > max[c]!) max[c] = v;
      }
    }
    let channel = 0;
    let range = -1;
    for (let c = 0; c < 4; c++) {
      const weighted = (max[c]! - min[c]!) * WEIGHTS[c]!;
      if (weighted > range) {
        range = weighted;
        channel = c;
      }
    }
    return { start, end, population, channel, score: end - start > 1 ? range * population : -1 };
  };

  const boxes: Box[] = [describe(0, entries)];
  while (boxes.length < target) {
    let pick = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i]!.score > 0 && (pick < 0 || boxes[i]!.score > boxes[pick]!.score)) pick = i;
    }
    if (pick < 0) break;
    const box = boxes[pick]!;
    const c = box.channel;
    order.subarray(box.start, box.end).sort((a, b) => colors[a * 4 + c]! - colors[b * 4 + c]!);
    let split = box.start + 1;
    for (let i = box.start, seen = 0; i < box.end - 1; i++) {
      seen += counts[order[i]!]!;
      split = i + 1;
      if (seen >= box.population / 2) break;
    }
    boxes.splice(pick, 1, describe(box.start, split), describe(split, box.end));
  }

  const palette = new Float64Array(boxes.length * 4);
  boxes.forEach((box, b) => {
    for (let i = box.start; i < box.end; i++) {
      const s = order[i]!;
      for (let c = 0; c < 4; c++) palette[b * 4 + c]! += (colors[s * 4 + c]! * counts[s]!) / box.population;
    }
  });
  return palette;
}

function refine(palette: Float64Array, colors: Float64Array, counts: Float64Array, entries: number, rounds: number): Float64Array {
  const size = palette.length / 4;
  let current = palette;
  for (let round = 0; round < rounds; round++) {
    const premultiplied = premultiply(current);
    const sums = new Float64Array(size * 4);
    const weights = new Float64Array(size);
    for (let s = 0; s < entries; s++) {
      const k = nearestIndex(premultiplied, size, colors[s * 4]!, colors[s * 4 + 1]!, colors[s * 4 + 2]!, colors[s * 4 + 3]!);
      weights[k]! += counts[s]!;
      for (let c = 0; c < 4; c++) sums[k * 4 + c]! += colors[s * 4 + c]! * counts[s]!;
    }
    const next = new Float64Array(current);
    for (let k = 0; k < size; k++) {
      if (weights[k]! > 0) for (let c = 0; c < 4; c++) next[k * 4 + c] = sums[k * 4 + c]! / weights[k]!;
    }
    current = next;
  }
  return current;
}

/** Colours compared premultiplied by alpha, so faint pixels match regardless of their hue. */
function premultiply(palette: Float64Array): Float64Array {
  const out = new Float64Array(palette.length);
  for (let i = 0; i < palette.length; i += 4) {
    const alpha = palette[i + 3]! / 255;
    out[i] = palette[i]! * alpha;
    out[i + 1] = palette[i + 1]! * alpha;
    out[i + 2] = palette[i + 2]! * alpha;
    out[i + 3] = palette[i + 3]!;
  }
  return out;
}

function nearestIndex(premultiplied: Float64Array, count: number, r: number, g: number, b: number, a: number): number {
  const alpha = a / 255;
  const pr = r * alpha;
  const pg = g * alpha;
  const pb = b * alpha;
  let best = 0;
  let bestDistance = Infinity;
  for (let k = 0; k < count; k++) {
    const dr = premultiplied[k * 4]! - pr;
    const dg = premultiplied[k * 4 + 1]! - pg;
    const db = premultiplied[k * 4 + 2]! - pb;
    const da = premultiplied[k * 4 + 3]! - a;
    const distance = WEIGHTS[0] * dr * dr + WEIGHTS[1] * dg * dg + WEIGHTS[2] * db * db + WEIGHTS[3] * da * da;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = k;
    }
  }
  return best;
}

/** Serpentine Floyd–Steinberg; transparent pixels neither receive nor spread error. */
function floydSteinberg(
  rgba: Pixels,
  width: number,
  palette: Float64Array,
  indices: Uint8Array,
  transparentIndex: number,
  nearest: (r: number, g: number, b: number, a: number) => number,
): void {
  const height = indices.length / width;
  let current = new Float32Array((width + 2) * 4);
  let next = new Float32Array((width + 2) * 4);
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

  for (let y = 0; y < height; y++) {
    const forward = y % 2 === 0;
    const step = forward ? 1 : -1;
    next.fill(0);
    for (let n = 0; n < width; n++) {
      const x = forward ? n : width - 1 - n;
      const i = y * width + x;
      const p = i * 4;
      if (rgba[p + 3] === 0) {
        indices[i] = transparentIndex;
        continue;
      }
      const e = (x + 1) * 4;
      const r = clamp(rgba[p]! + current[e]!);
      const g = clamp(rgba[p + 1]! + current[e + 1]!);
      const b = clamp(rgba[p + 2]! + current[e + 2]!);
      const a = clamp(rgba[p + 3]! + current[e + 3]!);
      const k = nearest(r, g, b, a);
      indices[i] = k;
      for (let c = 0; c < 4; c++) {
        const value = c === 0 ? r : c === 1 ? g : c === 2 ? b : a;
        const error = (value - palette[k * 4 + c]!) * DITHER_STRENGTH;
        current[e + step * 4 + c]! += (error * 7) / 16;
        next[e - step * 4 + c]! += (error * 3) / 16;
        next[e + c]! += (error * 5) / 16;
        next[e + step * 4 + c]! += error / 16;
      }
    }
    [current, next] = [next, current];
  }
}

/** Drops unused entries and rounds the palette to bytes. */
function compact(palette: Float64Array, indices: Uint8Array): IndexedImage {
  const used = new Int16Array(palette.length / 4).fill(-1);
  let count = 0;
  for (let i = 0; i < indices.length; i++) {
    const k = indices[i]!;
    if (used[k]! < 0) used[k] = count++;
    indices[i] = used[k]!;
  }
  const out = new Uint8Array(count * 4);
  used.forEach((to, from) => {
    if (to < 0) return;
    for (let c = 0; c < 4; c++) out[to * 4 + c] = Math.round(palette[from * 4 + c]!);
  });
  // A fully transparent entry must stay exactly transparent.
  for (let k = 0; k < count; k++) if (out[k * 4 + 3] === 0) out.fill(0, k * 4, k * 4 + 4);
  return { palette: out, indices };
}
