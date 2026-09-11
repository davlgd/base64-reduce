/** Small DOM helpers shared by the page modules. */

/** Looks up an element by id and checks its type, so a renamed id or tag fails loudly at start-up. */
export function byId(id: string): HTMLElement;
export function byId<T extends HTMLElement>(id: string, type: new () => T): T;
export function byId(id: string, type: new () => HTMLElement = HTMLElement): HTMLElement {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`#${id} is missing or is not a ${type.name}`);
  return element;
}

/** A decoded image and the blob URL it was read from; the caller revokes the URL when done. */
export interface LoadedImage {
  readonly url: string;
  readonly image: HTMLImageElement;
}

/** Decodes bytes as an image. Rejects, and frees the blob URL, when the browser can't display them. */
export async function loadImage(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<LoadedImage> {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
    return { url, image };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

/** Copies text. Falls back to a temporary selection where the Clipboard API is unavailable (plain HTTP). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.readOnly = true;
    scratch.className = "visually-hidden";
    document.body.append(scratch);
    const focused = document.activeElement;
    scratch.select();
    // Deprecated, but the only option left once the Clipboard API is refused.
    const copied = document.execCommand("copy");
    scratch.remove();
    if (focused instanceof HTMLElement) focused.focus();
    return copied;
  }
}

export const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
