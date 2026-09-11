/**
 * Page entry point: the Base64 field, decoding and the source bar. Imports, the preview and the
 * compression panel live in their own modules; this one wires them together.
 */
import { createCompressionPanel } from "./compression-panel.ts";
import { decodeImage, type DecodeError, type DecodedImage } from "./decode.ts";
import { byId, loadImage } from "./dom.ts";
import { formatBytes, formatCount } from "./format.ts";
import { IS_MAC, setUpImports } from "./imports.ts";
import { SAMPLE_DATA_URI } from "./sample.ts";
import { createStage } from "./stage.ts";

const workbench = byId("workbench");
const form = byId("viewer", HTMLFormElement);
const source = byId("source", HTMLTextAreaElement);
const sourceError = byId("source-error");
const editButton = byId("edit-source", HTMLButtonElement);
const facts = { format: byId("fact-format"), dimensions: byId("fact-dimensions"), size: byId("fact-size") };
const status = byId("status");

const TYPING_DELAY_MS = 300;

let currentUrl: string | null = null;
let renderId = 0;
/** Bumped by every new input (typing, paste, import, clear): async work checks it after each await. */
let inputGeneration = 0;
let typingTimer: ReturnType<typeof setTimeout> | undefined;

const stage = createStage();
const panel = createCompressionPanel({
  workerUrl: workbench.dataset.worker ?? "",
  stage,
  inputToken: () => inputGeneration,
  selectOriginal(dataUri, token) {
    if (token !== inputGeneration) return;
    // The field is folded away once an image is loaded: open it before selecting.
    if (workbench.dataset.state === "ready") setEditing(true);
    // Same image, normalised: replacing the field's text doesn't change the source.
    if (source.value.trim() !== dataUri) source.value = dataUri;
    source.focus();
    source.select();
  },
  onUseResult: (dataUri) => load(dataUri, "Loaded the result as the new source."),
});

interface RenderOptions {
  /** Announce the outcome to assistive technologies (explicit actions only, not keystrokes). */
  readonly announce: boolean;
  /** Move focus to the offending character when the input is invalid. */
  readonly focusError?: boolean;
  /** Message announced instead of the default one on success. */
  readonly message?: string;
  /** Loaded from outside the field: bring the result into view once it is ready. */
  readonly external?: boolean;
}

function render(options: RenderOptions): void {
  clearTimeout(typingTimer);
  const id = ++renderId;
  const result = decodeImage(source.value);
  if (!result.ok) {
    reset();
    if (result.error.kind === "empty") {
      setError(null);
      if (options.announce) announce("Paste a Base64 string first.");
      return;
    }
    const message = describeError(result.error);
    setError(message);
    if (options.announce) announce(message);
    if (options.focusError) focusError(result.error);
    return;
  }

  const { image } = result;
  loadImage(image.bytes, image.format.mime).then(
    ({ url, image: element }) => {
      if (id !== renderId) return URL.revokeObjectURL(url);
      // SVG without intrinsic size: browsers fall back to 300 × 150 when drawing it.
      const width = element.naturalWidth || 300;
      const height = element.naturalHeight || 150;
      // Never hide the field while it has focus, whatever started the load.
      setEditing(document.activeElement === source);
      show(image, url, width, height);
      if (options.external) panel.revealNextResult();
      panel.setSource({ image, element, url, width, height });
      if (options.announce) {
        announce(options.message ?? `${image.format.label} image decoded, ${formatCount(width)} by ${formatCount(height)} pixels.`);
      }
    },
    () => {
      if (id !== renderId) return;
      reset();
      const message = `This looks like a ${image.format.label} image, but the browser can't display it. The data may be truncated or corrupted.`;
      setError(message);
      if (options.announce) announce(message);
    },
  );
}

function show(image: DecodedImage, url: string, width: number, height: number): void {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = url;
  setError(null);
  facts.format.textContent = image.format.label;
  facts.dimensions.textContent = `${formatCount(width)} × ${formatCount(height)} px`;
  facts.size.textContent = formatBytes(image.bytes.byteLength);
  workbench.dataset.state = "ready";
  stage.setOriginal({ url, width, height, raster: image.format.raster, label: image.format.label });
}

/** Shows or folds the Base64 field once an image is loaded (it is always shown when empty). */
function setEditing(editing: boolean): void {
  workbench.toggleAttribute("data-editing", editing);
  editButton.setAttribute("aria-expanded", String(editing));
  editButton.textContent = editing ? "Hide Base64" : "Edit Base64";
}

function reset(): void {
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = null;
  workbench.dataset.state = "empty";
  setEditing(false);
  stage.clear();
  panel.clear();
}

function setError(message: string | null): void {
  sourceError.textContent = message ?? "";
  sourceError.hidden = message === null;
  if (message === null) source.removeAttribute("aria-invalid");
  else source.setAttribute("aria-invalid", "true");
}

function describeError(error: Exclude<DecodeError, { kind: "empty" }>): string {
  switch (error.kind) {
    case "not-base64-uri":
      return 'This data URI isn\'t Base64-encoded: ";base64" is missing before the comma.';
    case "invalid-char":
      return `Invalid character at position ${formatCount(error.index + 1)}: ${describeChar(error.char)}.`;
    case "bad-padding":
      return `"=" at position ${formatCount(error.index + 1)}: padding can only end the string.`;
    case "bad-length":
      return "The string looks truncated. Check that you copied all of it.";
    case "unknown-format":
      return "Valid Base64, but not a supported image (PNG, JPEG, GIF, WebP, AVIF, SVG, BMP or ICO).";
  }
}

function describeChar(char: string): string {
  const code = `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
  return /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(char) ? `"${char}"` : `invisible character ${code}`;
}

function focusError(error: DecodeError): void {
  source.focus();
  if (error.kind === "invalid-char") source.setSelectionRange(error.index, error.index + error.char.length);
  else if (error.kind === "bad-padding") source.setSelectionRange(error.index, error.index + 1);
}

/** Updates the polite live region; clearing first makes repeated messages audible again. */
function announce(message: string): void {
  status.textContent = "";
  requestAnimationFrame(() => {
    status.textContent = message;
  });
}

/** Replaces the source with text from outside the field (import, example, paste elsewhere). */
function load(text: string, message?: string): void {
  inputGeneration++;
  source.value = text;
  render({ announce: true, external: true, ...(message ? { message } : {}) });
}

setUpImports(
  {
    load,
    begin: () => ++inputGeneration,
    isCurrent: (token) => token === inputGeneration,
    fail(message) {
      // The error lives under the Base64 field: make sure it is on screen.
      if (workbench.dataset.state === "ready") setEditing(true);
      setError(message);
      announce(message);
    },
    announce,
    focusField() {
      if (workbench.dataset.state === "ready") setEditing(true);
      source.focus();
    },
  },
  workbench,
);

form.addEventListener("submit", (event) => {
  event.preventDefault();
  render({ announce: true, focusError: true });
});

source.addEventListener("input", (event) => {
  inputGeneration++;
  const kind = event instanceof InputEvent ? event.inputType : "";
  if (kind === "insertFromPaste" || kind === "insertFromDrop") return render({ announce: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => render({ announce: false }), TYPING_DELAY_MS);
});

source.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    form.requestSubmit();
  }
});

byId("sample").addEventListener("click", () => load(SAMPLE_DATA_URI, "Example image loaded."));

editButton.addEventListener("click", () => {
  const open = !workbench.hasAttribute("data-editing");
  setEditing(open);
  if (open) source.focus();
});

byId("clear").addEventListener("click", () => {
  clearTimeout(typingTimer);
  inputGeneration++;
  renderId++;
  source.value = "";
  reset();
  setError(null);
  announce("Cleared.");
  source.focus();
});

if (IS_MAC) byId("shortcut-key").textContent = "⌘";

// Browsers may restore the field's content on back/forward navigation.
if (source.value.trim()) render({ announce: false });
