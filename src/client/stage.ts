/** The single preview: shows the original or the result, on a chosen background. */
import { byId } from "./dom.ts";

export interface StageImage {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  /** Raster images are enlarged with visible pixels; vector ones stay smooth. */
  readonly raster: boolean;
  readonly label: string;
}

/** Small images are enlarged so their pixels stay inspectable. */
const TINY_IMAGE_TARGET = 128;
const BACKDROP_KEY = "base64-reduce:backdrop";

export function createStage() {
  const figure = byId("stage");
  const image = byId("preview-image", HTMLImageElement);
  const originalRadio = byId("view-original", HTMLInputElement);
  const resultRadio = byId("view-result", HTMLInputElement);
  const backdropRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="backdrop"]')];

  let original: StageImage | null = null;
  let result: StageImage | null = null;
  let wantsResult = false;

  function show(animate: boolean): void {
    const showingResult = wantsResult && result !== null;
    const shown = showingResult ? result : original;
    originalRadio.checked = !showingResult;
    resultRadio.checked = showingResult;
    resultRadio.disabled = result === null;
    if (!shown || !original) {
      image.hidden = true;
      image.removeAttribute("src");
      image.alt = "";
      return;
    }
    // Both versions are displayed at the original's size, so differences are visible.
    const scale = Math.max(1, Math.floor(TINY_IMAGE_TARGET / Math.max(original.width, original.height)));
    image.style.width = `${original.width * scale}px`;
    image.classList.toggle("is-pixelated", scale > 1 && shown.raster);
    image.classList.toggle("is-new", animate);
    image.src = shown.url;
    image.alt = `${showingResult ? "Result" : "Original"}: ${shown.label}, ${shown.width} × ${shown.height} pixels`;
    image.hidden = false;
  }

  function setBackdrop(value: string): void {
    figure.dataset.backdrop = value;
  }

  originalRadio.addEventListener("change", () => {
    wantsResult = false;
    show(false);
  });
  resultRadio.addEventListener("change", () => {
    wantsResult = true;
    show(false);
  });

  // The background choice is remembered per browser; storage can be unavailable (private mode).
  for (const radio of backdropRadios) {
    radio.addEventListener("change", () => {
      setBackdrop(radio.value);
      try {
        localStorage.setItem(BACKDROP_KEY, radio.value);
      } catch {}
    });
  }
  try {
    const saved = backdropRadios.find((radio) => radio.value === localStorage.getItem(BACKDROP_KEY));
    if (saved) {
      saved.checked = true;
      setBackdrop(saved.value);
    }
  } catch {}

  return {
    setOriginal(next: StageImage): void {
      original = next;
      result = null;
      wantsResult = false;
      show(true);
    },
    /** A new result is shown straight away; the Original tab stays one click away. */
    setResult(next: StageImage | null): void {
      result = next;
      if (next) wantsResult = true;
      show(false);
    },
    setBusy(busy: boolean): void {
      figure.toggleAttribute("data-busy", busy);
    },
    clear(): void {
      original = null;
      result = null;
      wantsResult = false;
      figure.toggleAttribute("data-busy", false);
      show(false);
    },
  };
}

export type Stage = ReturnType<typeof createStage>;
