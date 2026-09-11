/**
 * Every way to bring an image in from outside the Base64 field: the file picker, the Paste
 * button, pasting anywhere on the page and drag and drop. Text goes to `load`, files are
 * read first; editable fields keep their native paste and drop behaviour.
 */
import { bytesToBase64 } from "./decode.ts";
import { byId } from "./dom.ts";
import { formatBytes } from "./format.ts";

export interface ImportTarget {
  /** Replaces the source with text from outside the field. */
  load(text: string, message?: string): void;
  /** Starts a new input and returns its token; any newer input makes older tokens stale. */
  begin(): number;
  isCurrent(token: number): boolean;
  /** Reports an import that couldn't be completed. */
  fail(message: string): void;
  announce(message: string): void;
  /** Sends the user to the Base64 field when the clipboard can't be read. */
  focusField(): void;
}

/** Beyond this, the Base64 text alone would make the page sluggish. */
const MAX_FILE_BYTES = 25_000_000;

export function setUpImports(target: ImportTarget, workbench: HTMLElement): void {
  const fileInput = byId("file", HTMLInputElement);
  const pasteButton = byId("paste", HTMLButtonElement);

  /** Reads a file into the field. Returns false if it was rejected, failed, or superseded by newer input. */
  async function loadFile(file: File): Promise<boolean> {
    const token = target.begin();
    if (file.size > MAX_FILE_BYTES) {
      target.fail(`${file.name} is larger than the ${formatBytes(MAX_FILE_BYTES)} limit (${formatBytes(file.size)}).`);
      return false;
    }
    try {
      const text = isTextFile(file) ? await file.text() : `data:${imageMime(file)};base64,${bytesToBase64(new Uint8Array(await file.arrayBuffer()))}`;
      if (!target.isCurrent(token)) return false;
      target.load(text, `Opened ${file.name}.`);
      return true;
    } catch {
      if (target.isCurrent(token)) target.fail(`Couldn't read ${file.name}.`);
      return false;
    }
  }

  function loadFiles(files: Iterable<File>): void {
    const [first, ...others] = files;
    if (!first) return;
    void loadFile(first).then((loaded) => {
      if (loaded && others.length > 0) target.announce(`Opened ${first.name}. Only one file at a time is supported.`);
    });
  }

  fileInput.addEventListener("change", () => {
    if (fileInput.files) loadFiles(fileInput.files);
    fileInput.value = "";
  });

  if (typeof navigator.clipboard?.readText === "function") {
    pasteButton.hidden = false;
    pasteButton.addEventListener("click", async () => {
      const token = target.begin();
      try {
        // Images first where the browser allows reading them, then plain text.
        for (const item of (await navigator.clipboard.read?.()) ?? []) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (!type) continue;
          const blob = await item.getType(type);
          if (target.isCurrent(token)) void loadFile(new File([blob], "clipboard image", { type }));
          return;
        }
        const text = await navigator.clipboard.readText();
        if (target.isCurrent(token)) target.load(text, "Pasted from the clipboard.");
      } catch {
        if (!target.isCurrent(token)) return;
        target.announce(`Can't read the clipboard here. Click the field and press ${IS_MAC ? "⌘" : "Ctrl"} + V.`);
        target.focusField();
      }
    });
  }

  document.addEventListener("paste", (event) => {
    if (isEditable(event.target) || !event.clipboardData) return;
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    const text = event.clipboardData.getData("text/plain");
    if (images.length > 0) loadFiles(images);
    else if (text.trim()) target.load(text);
    else return;
    event.preventDefault();
  });

  let dragDepth = 0;
  const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
  document.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    dragDepth++;
    workbench.classList.add("is-dragging");
  });
  document.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) workbench.classList.remove("is-dragging");
  });
  document.addEventListener("dragover", (event) => {
    if (carriesFiles(event) || (!isEditable(event.target) && event.dataTransfer?.types.includes("text/plain"))) {
      event.preventDefault();
    }
  });
  document.addEventListener("drop", (event) => {
    dragDepth = 0;
    workbench.classList.remove("is-dragging");
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const text = transfer.getData("text/plain");
    if (transfer.files.length > 0) loadFiles(transfer.files);
    else if (!isEditable(event.target) && text.trim()) target.load(text);
    else return;
    event.preventDefault();
  });
}

export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

function isEditable(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches("input, textarea, select"));
}

function isTextFile(file: File): boolean {
  return file.type.startsWith("text/") || /\.(txt|b64|base64)$/i.test(file.name);
}

/** The file's own image type when it declares one; the decoder identifies the format from the bytes anyway. */
function imageMime(file: File): string {
  return file.type.startsWith("image/") ? file.type : "application/octet-stream";
}
