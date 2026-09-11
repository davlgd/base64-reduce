/**
 * Page side of the compression worker: starts it on demand, sends pixels only when they change,
 * and runs one encode at a time. While one runs, only the most recent request waits; an older
 * waiting request resolves with null.
 */
import type { RasterFormat } from "./formats.ts";
import type { RasterSettings, WorkerRequest, WorkerResponse } from "./reduce-protocol.ts";

export const canCompress =
  typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof CompressionStream === "function";

export interface Encoded {
  readonly format: RasterFormat;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
  /** How many formats were encoded to pick this one. */
  readonly tried: number;
}

export interface EncodeRequest {
  /** Identifies the pixels: they are re-sent only when this object or the size below changes. */
  readonly source: object;
  readonly width: number;
  readonly height: number;
  /** Draws the pixels at that size; called only when they must be sent. */
  readonly draw: () => ImageBitmap;
  readonly settings: RasterSettings;
}

interface Job {
  readonly request: EncodeRequest;
  readonly resolve: (encoded: Encoded | null) => void;
  readonly reject: (error: Error) => void;
}

export function createCompressor(workerUrl: string) {
  let worker: Worker | null = null;
  let broken: Error | null = null;
  const capabilities = Promise.withResolvers<readonly RasterFormat[]>();
  // A failure is reported to whoever asks for the formats; don't flag it as unhandled meanwhile.
  capabilities.promise.catch(() => {});
  let sent: { source: object; width: number; height: number } | null = null;
  let nextId = 0;
  let running: { id: number; job: Job } | null = null;
  let waiting: Job | null = null;

  function start(): Worker {
    if (worker) return worker;
    worker = new Worker(workerUrl, { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => receive(data);
    worker.onerror = () => breakDown(new Error("the compression worker could not start"));
    return worker;
  }

  function post(message: WorkerRequest, transfer: Transferable[] = []): void {
    start().postMessage(message, transfer);
  }

  function dispatch(job: Job): void {
    const { request } = job;
    if (sent?.source !== request.source || sent.width !== request.width || sent.height !== request.height) {
      const bitmap = request.draw();
      post({ type: "source", bitmap }, [bitmap]);
      sent = { source: request.source, width: request.width, height: request.height };
    }
    running = { id: ++nextId, job };
    post({ type: "encode", id: running.id, settings: request.settings });
  }

  function receive(message: WorkerResponse): void {
    if (message.type === "capabilities") return capabilities.resolve(message.formats);
    if (message.id !== running?.id) return;
    const { job } = running;
    running = null;
    if (message.type === "error") job.reject(new Error(message.message));
    else job.resolve({ format: message.format, bytes: message.bytes, width: message.width, height: message.height, tried: message.tried });
    if (waiting) {
      const next = waiting;
      waiting = null;
      dispatch(next);
    }
  }

  function breakDown(error: Error): void {
    broken = error;
    capabilities.reject(error);
    running?.job.reject(error);
    waiting?.reject(error);
    running = waiting = null;
  }

  return {
    /** Raster formats this browser can encode; starts the worker on first use. */
    formats(): Promise<readonly RasterFormat[]> {
      if (!broken) start();
      return capabilities.promise;
    },
    /** Resolves with the result, or with null if a newer request replaced this one before it started. */
    encode(request: EncodeRequest): Promise<Encoded | null> {
      if (broken) return Promise.reject(broken);
      const { promise, resolve, reject } = Promise.withResolvers<Encoded | null>();
      const job: Job = { request, resolve, reject };
      if (running) {
        waiting?.resolve(null);
        waiting = job;
      } else {
        dispatch(job);
      }
      return promise;
    },
  };
}
