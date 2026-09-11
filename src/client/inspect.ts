/** Detects animated GIF, WebP and PNG (APNG): re-encoding through a canvas keeps only the first frame. */

import type { ImageFormat } from "./formats.ts";

export function isAnimated(bytes: Uint8Array, format: ImageFormat): boolean {
  switch (format.extension) {
    case "gif":
      return countGifFrames(bytes) > 1;
    case "webp":
      // VP8X header: flags byte at offset 20, animation bit 0x02.
      return text(bytes, 12, "VP8X") && (bytes[20]! & 0x02) !== 0;
    case "png":
      return hasPngChunk(bytes, "acTL");
    default:
      return false;
  }
}

function text(bytes: Uint8Array, offset: number, value: string): boolean {
  for (let i = 0; i < value.length; i++) if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  return true;
}

function countGifFrames(bytes: Uint8Array): number {
  let offset = 13;
  if (bytes[10]! & 0x80) offset += 3 * 2 ** ((bytes[10]! & 0x07) + 1);
  const skipSubBlocks = () => {
    while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset]! + 1;
    offset++;
  };
  let frames = 0;
  while (offset < bytes.length) {
    const block = bytes[offset++];
    if (block === 0x2c) {
      frames++;
      if (frames > 1) return frames;
      const packed = bytes[offset + 8]!;
      offset += 9;
      if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1);
      offset++; // LZW minimum code size
      skipSubBlocks();
    } else if (block === 0x21) {
      offset++; // extension label
      skipSubBlocks();
    } else {
      break; // trailer (0x3b) or corrupt data
    }
  }
  return frames;
}

function hasPngChunk(bytes: Uint8Array, type: string): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    if (text(bytes, offset + 4, type)) return true;
    if (text(bytes, offset + 4, "IDAT")) return false;
    offset += 12 + view.getUint32(offset);
  }
  return false;
}
