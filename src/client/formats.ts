/** The image formats the tool knows: one source for labels, MIME types and file extensions. */

export interface ImageFormat {
  readonly label: string;
  readonly mime: string;
  readonly extension: string;
  /** Whether the preview should use nearest-neighbour scaling when enlarged. */
  readonly raster: boolean;
}

export const FORMATS = {
  png: { label: "PNG", mime: "image/png", extension: "png", raster: true },
  jpeg: { label: "JPEG", mime: "image/jpeg", extension: "jpg", raster: true },
  gif: { label: "GIF", mime: "image/gif", extension: "gif", raster: true },
  webp: { label: "WebP", mime: "image/webp", extension: "webp", raster: true },
  avif: { label: "AVIF", mime: "image/avif", extension: "avif", raster: true },
  svg: { label: "SVG", mime: "image/svg+xml", extension: "svg", raster: false },
  bmp: { label: "BMP", mime: "image/bmp", extension: "bmp", raster: true },
  ico: { label: "ICO", mime: "image/x-icon", extension: "ico", raster: true },
} as const satisfies Record<string, ImageFormat>;

/** Formats the browser may be able to encode from a canvas. */
export type RasterFormat = "webp" | "avif" | "png" | "jpeg";

/** Length of `data:<mime>;base64,<payload>` for a file of `bytes` bytes: what users paste and compare. */
export function dataUriLength(mime: string, bytes: number): number {
  return `data:${mime};base64,`.length + 4 * Math.ceil(bytes / 3);
}
