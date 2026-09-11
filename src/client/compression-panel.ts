/** The compression panel: settings, the result card and its actions. Encoding itself is in compressor.ts. */
import { canCompress, createCompressor } from "./compressor.ts";
import { bytesToBase64, type DecodedImage } from "./decode.ts";
import { byId, copyText, loadImage, prefersReducedMotion } from "./dom.ts";
import { dataUriLength, FORMATS, type RasterFormat } from "./formats.ts";
import { describeChange, formatBytes, formatCount } from "./format.ts";
import { isAnimated } from "./inspect.ts";
import type { RasterSettings } from "./reduce-protocol.ts";
import type { Stage } from "./stage.ts";
import { minifySvg } from "./svg.ts";

export interface PanelSource {
  readonly image: DecodedImage;
  /** The decoded image, drawn into a canvas for the worker. */
  readonly element: HTMLImageElement;
  readonly width: number;
  readonly height: number;
  readonly url: string;
}

export interface PanelOptions {
  readonly workerUrl: string;
  readonly stage: Stage;
  /** Loads a data URI as the new source image. */
  readonly onUseResult: (dataUri: string) => void;
  /** Identifies the current input; any newer input (typing, clear, import) changes it. */
  readonly inputToken: () => number;
  /** Puts the original data URI in the source field and selects it, unless the input changed since `token`. */
  readonly selectOriginal: (dataUri: string, token: number) => void;
}

type OutputFormat = RasterFormat | "auto" | "svg";

interface Result {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly format: RasterFormat | "svg";
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** Formats encoded to pick this one (0 for SVG). */
  readonly tried: number;
  /** True when nothing shorter than the source was found. */
  readonly keptOriginal: boolean;
}

/** Fixed order, most useful first: WebP before PNG, JPEG last. */
const RASTER_ORDER: readonly RasterFormat[] = ["webp", "avif", "png", "jpeg"];
const HINTS: Record<OutputFormat, string> = {
  auto: "Tries each eligible format and keeps the shortest.",
  webp: "Good for photos and illustrations.",
  avif: "Often the smallest. Slower to encode.",
  jpeg: "Opaque photos. No transparency.",
  png: "Lossless, or fewer colors for logos and screenshots.",
  svg: "Cleans up the markup. Stays vector.",
};
const SETTLE_MS = 250;
const SVG_PRECISION = 3;
const COPY_FEEDBACK_MS = 1600;

const label = (format: OutputFormat) => (format === "auto" ? "Auto" : FORMATS[format].label);
const isSvg = (s: PanelSource) => s.image.format === FORMATS.svg;
const originalUri = (s: PanelSource) => `data:${s.image.format.mime};base64,${s.image.base64}`;

export function createCompressionPanel({ workerUrl, stage, onUseResult, inputToken, selectOriginal }: PanelOptions) {
  const form = byId("reduce-form", HTMLFormElement);
  const formatGroup = byId("reduce-format");
  const formatHint = byId("reduce-format-hint");
  const quality = byId("reduce-quality", HTMLInputElement);
  const qualityValue = byId("reduce-quality-value", HTMLOutputElement);
  const colors = byId("reduce-colors", HTMLSelectElement);
  const scale = byId("reduce-scale", HTMLInputElement);
  const sizeValue = byId("reduce-size-value", HTMLOutputElement);
  const width = byId("reduce-width", HTMLInputElement);
  const dither = byId("reduce-dither", HTMLInputElement);
  const background = byId("reduce-background", HTMLInputElement);
  const precision = byId("reduce-precision", HTMLInputElement);
  const warning = byId("reduce-warning");
  const fields = {
    quality: byId("field-quality"),
    colors: byId("field-colors"),
    size: byId("field-size"),
    width: byId("field-width"),
    dither: byId("field-dither"),
    background: byId("field-background"),
    precision: byId("field-precision"),
  };

  const output = byId("output");
  const verdict = byId("verdict");
  const verdictDetail = byId("verdict-detail");
  const meter = byId("bar-result");
  const meta = byId("result-meta");
  const summary = byId("output-summary");
  const note = byId("output-note");
  const status = byId("reduce-status");
  const copyButton = byId("reduced-copy", HTMLButtonElement);
  const download = byId("reduced-download", HTMLAnchorElement);
  const useButton = byId("reduced-use", HTMLButtonElement);
  const more = byId("result-more", HTMLDetailsElement);
  const outputField = byId("reduced-output", HTMLInputElement);
  const copyOriginal = byId("original-copy", HTMLButtonElement);
  const downloadOriginal = byId("original-download", HTMLAnchorElement);

  const compressor = createCompressor(workerUrl);
  let formats: readonly RasterFormat[] | null = null;
  let source: PanelSource | null = null;
  let result: { value: Result; url: string; dataUri: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reveal = false;
  /** Bumped by every settings change, new source or clear: any older computation is stale. */
  let generation = 0;

  // Formats

  function currentFormat(): OutputFormat {
    return (formatGroup.querySelector<HTMLInputElement>('input[name="format"]:checked')?.value ?? "auto") as OutputFormat;
  }

  function populateFormats(s: PanelSource, keepChoice: boolean): void {
    const previous = keepChoice ? currentFormat() : null;
    const raster = RASTER_ORDER.filter((format) => formats?.includes(format));
    const options: OutputFormat[] = isSvg(s) ? ["svg", ...raster] : raster.length ? ["auto", ...raster] : [];
    const chosen = previous && options.includes(previous) ? previous : options[0];
    formatGroup.replaceChildren(
      ...options.map((value) => {
        const input = Object.assign(document.createElement("input"), { type: "radio", name: "format", value, checked: value === chosen });
        const text = Object.assign(document.createElement("span"), { textContent: label(value) });
        const choice = Object.assign(document.createElement("label"), { className: "choice" });
        choice.append(input, text);
        return choice;
      }),
    );
    updateFields();
  }

  /** Asks the worker once which formats this browser can encode, then offers them. */
  function requestFormats(): void {
    if (formats || !canCompress) return;
    compressor.formats().then(
      (available) => {
        formats = available;
        if (source) {
          populateFormats(source, true);
          schedule();
        }
      },
      () => fail("Compression could not start in this browser."),
    );
  }

  // Settings

  /** Output size: the exact width field is the reference, the percentage slider writes into it. */
  function targetSize(s: PanelSource): { width: number; height: number } {
    const requested = Math.round(Number(width.value));
    const w = Number.isFinite(requested) && requested >= 1 ? Math.min(requested, s.width) : s.width;
    return { width: w, height: Math.max(1, Math.round((w * s.height) / s.width)) };
  }

  function updateFields(): void {
    const format = currentFormat();
    fields.quality.hidden = !(format === "auto" || format === "webp" || format === "avif" || format === "jpeg");
    fields.colors.hidden = format !== "png";
    fields.size.hidden = format === "svg";
    fields.width.hidden = format === "svg";
    fields.dither.hidden = format !== "png" || colors.value === "0";
    fields.background.hidden = format !== "jpeg";
    fields.precision.hidden = format !== "svg";
    if (!result || format !== "auto") formatHint.textContent = HINTS[format];
    qualityValue.value = quality.value;
    if (!source) return;
    const { width: w, height: h } = targetSize(source);
    if (document.activeElement !== width) width.value = String(w);
    const exact = (w / source.width) * 100;
    if (document.activeElement !== scale) scale.value = String(Math.max(Number(scale.min), Math.round(exact)));
    // The readout states the real share, even below the slider's range.
    const percent = exact < 1 ? "<1%" : `${Math.round(exact)}%`;
    sizeValue.value = `${formatCount(w)} × ${formatCount(h)} px (${percent})`;
    scale.setAttribute("aria-valuetext", `${percent}, ${w} by ${h} pixels`);
  }

  // Compression runs

  function schedule(): void {
    clearTimeout(timer);
    generation++;
    updateFields();
    if (!source) return;
    output.setAttribute("aria-busy", "true");
    stage.setBusy(true);
    // The shown result no longer matches the settings: it can't be exported until the new one lands.
    setResultActions(false);
    timer = setTimeout(run, SETTLE_MS);
  }

  function run(): void {
    const s = source;
    if (!s) return;
    const g = generation;
    const format = currentFormat();
    if (format === "svg") return finish(s, g, minifiedSvg(s));
    if (!canCompress) return fail("This browser can't recompress images (it needs OffscreenCanvas and Web Workers).");
    if (!formats) return; // requestFormats() schedules a run once they are known.
    const size = targetSize(s);
    const settings: RasterSettings = {
      format,
      quality: Number(quality.value),
      ...size,
      // The palette setting belongs to the PNG choice: Auto's PNG candidate stays lossless.
      colors: format === "png" ? Number(colors.value) : 0,
      dither: dither.checked,
      background: background.value,
    };
    // SVG is rasterised at the requested size to stay sharp; bitmaps are resized in the worker.
    const pixels = isSvg(s) ? size : { width: s.width, height: s.height };
    compressor.encode({ source: s, ...pixels, draw: () => rasterize(s, pixels), settings }).then(
      (encoded) => {
        if (!encoded || s !== source || g !== generation) return;
        const mime = FORMATS[encoded.format].mime;
        finish(s, g, { ...encoded, mime, keptOriginal: false });
      },
      (error: Error) => {
        if (s === source && g === generation) fail(`Compression failed: ${error.message}`);
      },
    );
  }

  function rasterize(s: PanelSource, size: { width: number; height: number }): ImageBitmap {
    const canvas = new OffscreenCanvas(size.width, size.height);
    canvas.getContext("2d")?.drawImage(s.element, 0, 0, size.width, size.height);
    return canvas.transferToImageBitmap();
  }

  function minifiedSvg(s: PanelSource): Result {
    const text = new TextDecoder().decode(s.image.bytes);
    let minified = minifySvg(text, { precision: precision.checked ? SVG_PRECISION : null });
    if (new DOMParser().parseFromString(minified, "image/svg+xml").querySelector("parsererror")) minified = text;
    const bytes = new TextEncoder().encode(minified);
    return { bytes, format: "svg", mime: FORMATS.svg.mime, width: s.width, height: s.height, tried: 0, keptOriginal: false };
  }

  function finish(s: PanelSource, g: number, candidate: Result): void {
    const format = currentFormat();
    const sameSize = candidate.width === s.width && candidate.height === s.height;
    const longer = dataUriLength(candidate.mime, candidate.bytes.byteLength) >= originalUri(s).length;
    // Auto and SVG never hand back a data URI longer than the one we started with.
    const value: Result =
      (format === "auto" || format === "svg") && sameSize && longer
        ? { ...candidate, bytes: s.image.bytes, mime: s.image.format.mime, keptOriginal: true }
        : candidate;
    loadImage(value.bytes, value.mime).then(
      ({ url }) => {
        if (s !== source || g !== generation) return URL.revokeObjectURL(url);
        if (result) URL.revokeObjectURL(result.url);
        result = { value, url, dataUri: `data:${value.mime};base64,${bytesToBase64(value.bytes)}` };
        showResult(s);
      },
      () => {
        if (s === source && g === generation) fail("The browser couldn't read the compressed image. Try another format.");
      },
    );
  }

  // Result card

  function showResult(s: PanelSource): void {
    if (!result) return;
    const { value, dataUri } = result;
    const before = originalUri(s).length;
    const after = dataUri.length;
    const change = describeChange(before, after);
    const name = value.keptOriginal ? s.image.format.label : label(value.format);

    verdict.textContent = value.keptOriginal ? "No smaller result" : change.text;
    verdict.dataset.trend = value.keptOriginal ? "flat" : change.trend;
    verdictDetail.textContent = value.keptOriginal
      ? `Nothing shorter than ${formatCount(before)} characters with these settings.`
      : `Data URI: ${formatCount(after)} characters instead of ${formatCount(before)}`;
    meter.style.setProperty("--share", `${Math.min(100, (after / before) * 100)}%`);
    meta.textContent = `${name}, ${formatBytes(value.bytes.byteLength)}, ${formatCount(value.width)} × ${formatCount(value.height)} px`;
    summary.textContent = `Original: ${formatCount(before)} characters. Result: ${name}, ${formatCount(after)} characters.`;
    showNote(
      value.keptOriginal
        ? "Try a smaller size or a lower quality."
        : change.trend === "up"
          ? "This result is longer than the original. Try another format."
          : null,
    );
    if (currentFormat() === "auto" && value.tried > 0) {
      formatHint.textContent = value.keptOriginal
        ? `None of the ${value.tried} formats tried beat the original.`
        : `Picked ${name}, the shortest of ${value.tried} formats tried.`;
    }

    download.download = `image-reduced.${value.keptOriginal ? s.image.format.extension : FORMATS[value.format].extension}`;
    setResultActions(true);
    outputField.value = dataUri;
    output.setAttribute("aria-busy", "false");
    stage.setBusy(false);
    stage.setResult({ url: result.url, width: value.width, height: value.height, raster: value.format !== "svg", label: name });

    if (reveal) {
      reveal = false;
      revealResult();
    }
    const comparison = change.trend === "flat" ? "the same length as the original" : `${change.text} than the original`;
    status.textContent = value.keptOriginal
      ? "Original kept: nothing shorter with these settings."
      : `Result: ${name}, ${formatCount(after)} characters, ${comparison}.`;
  }

  /** Shows the current source with no result yet. */
  function showPending(s: PanelSource): void {
    const length = formatCount(originalUri(s).length);
    verdict.textContent = "Compressing…";
    delete verdict.dataset.trend;
    verdictDetail.textContent = `The original is ${length} characters.`;
    meter.style.setProperty("--share", "0%");
    meta.textContent = "";
    showNote(null);
    summary.textContent = `Original: ${length} characters. No result yet.`;
  }

  /** No usable result: drop the previous one so nothing stale can be exported; the original stays available. */
  function fail(message: string): void {
    if (result) URL.revokeObjectURL(result.url);
    result = null;
    outputField.value = "";
    setResultActions(false);
    stage.setResult(null);
    if (source) showPending(source);
    output.setAttribute("aria-busy", "false");
    stage.setBusy(false);
    verdict.textContent = "No result";
    verdict.dataset.trend = "flat";
    showNote(message);
    status.textContent = message;
  }

  function showNote(message: string | null): void {
    note.hidden = message === null;
    note.textContent = message ?? "";
  }

  function setResultActions(enabled: boolean): void {
    copyButton.disabled = !enabled;
    useButton.disabled = !enabled || (result?.value.keptOriginal ?? true);
    if (enabled && result) download.href = result.url;
    else download.removeAttribute("href");
  }

  /** On one-column layouts the result sits below the image: scroll just enough to show it. */
  function revealResult(): void {
    if (copyButton.getBoundingClientRect().bottom <= window.innerHeight) return;
    document.querySelector(".view")?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }

  /** Confirms on the button itself for sighted users, and through the status region for everyone. */
  async function copyWithFeedback(button: HTMLButtonElement, text: string, what: "result" | "original"): Promise<void> {
    const token = inputToken();
    const copiedFrom = source;
    const copied = await copyText(text);
    const caption = button.querySelector(".button-label") ?? button;
    const original = caption.textContent;
    caption.textContent = copied ? "Copied" : "Copy failed";
    setTimeout(() => (caption.textContent = original), COPY_FEEDBACK_MS);
    status.textContent = copied
      ? `Copied the ${what} data URI (${formatCount(text.length)} characters).`
      : `Couldn't copy the ${what} data URI. Select the text and copy it with your keyboard.`;
    // The input changed while the clipboard answered: never move focus or rewrite the new input.
    if (copied || copiedFrom !== source || token !== inputToken()) return;
    if (what === "result") {
      if (result?.dataUri !== text) return;
      more.open = true;
      outputField.focus();
      outputField.select();
    } else {
      selectOriginal(text, token);
      status.textContent = "Couldn't copy the original data URI. It is selected in the Base64 field: copy it with your keyboard.";
    }
  }

  // Events

  form.addEventListener("submit", (event) => event.preventDefault());
  form.addEventListener("input", (event) => {
    if (event.target === scale && source) {
      width.value = String(Math.max(1, Math.round((source.width * Number(scale.value)) / 100)));
    }
    schedule();
  });
  width.addEventListener("change", () => {
    if (source) width.value = String(targetSize(source).width);
    schedule();
  });
  copyButton.addEventListener("click", () => {
    if (result) void copyWithFeedback(copyButton, result.dataUri, "result");
  });
  copyOriginal.addEventListener("click", () => {
    if (source) void copyWithFeedback(copyOriginal, originalUri(source), "original");
  });
  useButton.addEventListener("click", () => {
    if (!result || result.value.keptOriginal) return;
    // The new source is already compressed: start again from the automatic comparison.
    const auto = formatGroup.querySelector<HTMLInputElement>('input[name="format"][value="auto"]');
    if (auto) auto.checked = true;
    onUseResult(result.dataUri);
  });

  return {
    /** Scroll the next result into view: set by loads from outside the field, never by typing. */
    revealNextResult(): void {
      reveal = true;
    },
    setSource(next: PanelSource): void {
      // Keep the chosen format across images of the same kind; an SVG starts as minified SVG.
      const sameKind = source !== null && isSvg(source) === isSvg(next);
      source = next;
      if (result) URL.revokeObjectURL(result.url);
      result = null;
      width.max = String(next.width);
      width.value = String(next.width);
      scale.value = "100";
      more.open = false;
      showPending(next);
      downloadOriginal.href = next.url;
      downloadOriginal.download = `image-original.${next.image.format.extension}`;
      warning.hidden = !isAnimated(next.image.bytes, next.image.format);
      warning.textContent = "Animated image: re-encoding keeps a single frame. Keeping the original preserves the animation.";
      // Even for SVG: the worker reports which raster formats this browser can produce.
      requestFormats();
      populateFormats(next, sameKind);
      schedule();
    },
    clear(): void {
      source = null;
      reveal = false;
      generation++;
      clearTimeout(timer);
      if (result) URL.revokeObjectURL(result.url);
      result = null;
      warning.hidden = true;
      stage.setBusy(false);
      setResultActions(false);
      status.textContent = "";
    },
  };
}
