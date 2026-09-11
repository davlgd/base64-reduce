/** Messages exchanged between the page and the compression worker. */
import type { RasterFormat } from "./formats.ts";

export interface RasterSettings {
  /** "auto" encodes every eligible format and keeps the shortest data URI. */
  readonly format: RasterFormat | "auto";
  /** 1–100, for lossy formats. */
  readonly quality: number;
  readonly width: number;
  readonly height: number;
  /** PNG palette size; 0 keeps every colour (lossless). */
  readonly colors: number;
  readonly dither: boolean;
  /** Fill colour behind transparent areas, for JPEG. */
  readonly background: string;
}

export type WorkerRequest =
  | { readonly type: "source"; readonly bitmap: ImageBitmap }
  | { readonly type: "encode"; readonly id: number; readonly settings: RasterSettings };

export type WorkerResponse =
  | { readonly type: "capabilities"; readonly formats: readonly RasterFormat[] }
  | {
      readonly type: "result";
      readonly id: number;
      readonly format: RasterFormat;
      readonly bytes: Uint8Array<ArrayBuffer>;
      readonly width: number;
      readonly height: number;
      /** How many formats were encoded to pick this one (1 unless the format is "auto"). */
      readonly tried: number;
    }
  | { readonly type: "error"; readonly id: number; readonly message: string };
