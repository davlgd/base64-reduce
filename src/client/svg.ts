/**
 * Conservative SVG minifier: removes the prolog, comments, editor metadata and formatting
 * whitespace, compacts numbers and path data, and can round coordinates. Text, style and
 * script content is left untouched.
 */

export interface SvgOptions {
  /** Decimal places kept in geometry attributes, or null to keep numbers as they are. */
  readonly precision: number | null;
}

const EDITOR_NAMESPACES = "inkscape|sodipodi|sketch|serif|figma|rdf|cc|dc";
/** Attributes holding only numbers, lengths or path data. */
const GEOMETRY_ATTRIBUTES = new Set([
  "d", "points", "viewBox", "transform", "gradientTransform", "patternTransform",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy",
  "width", "height", "offset", "stroke-width", "stroke-dashoffset", "stroke-dasharray",
  "opacity", "fill-opacity", "stroke-opacity", "stop-opacity", "stroke-miterlimit",
]);
/** Elements whose inner whitespace can matter. */
const PRESERVE = /<(text|textPath|tspan|title|desc|style|script|pre)\b[\s\S]*?<\/\1\s*>/gi;
/** Placeholder around preserved blocks: NUL cannot appear in XML. */
const MARK = "\u0000";
const RESTORE = /\u0000(\d+)\u0000/g;
const EDITOR_ELEMENTS = new RegExp(`<(${EDITOR_NAMESPACES}):[\\w.-]+\\b[^>]*?(?:/>|>[\\s\\S]*?</\\1:[\\w.-]+\\s*>)`, "gi");
const EDITOR_ATTRIBUTES = new RegExp(
  `\\s(?:xmlns:(?:${EDITOR_NAMESPACES})|(?:${EDITOR_NAMESPACES}):[\\w.-]+)\\s*=\\s*(?:"[^"]*"|'[^']*')`,
  "gi",
);
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
const NUMBER_AT = new RegExp(NUMBER.source, "y");
/** Parameters per path command; arc flags (parameters 4 and 5 of "A") are single 0/1 characters. */
const PATH_ARITY: Readonly<Record<string, number>> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

export function minifySvg(source: string, { precision }: SvgOptions): string {
  const kept: string[] = [];
  let svg = source
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(PRESERVE, (block) => `${MARK}${kept.push(block) - 1}${MARK}`)
    .replace(/<metadata\b[\s\S]*?<\/metadata\s*>/gi, "")
    .replace(EDITOR_ELEMENTS, "")
    .replace(EDITOR_ATTRIBUTES, "");

  svg = svg
    .replace(/<[^>]+>/g, (tag) => minifyTag(tag, precision))
    // Whitespace between elements is not rendered (text elements are preserved above).
    .replace(/>\s+(?=[<\u0000])/g, ">")
    .replace(/(\u0000\d+\u0000)\s+(?=<)/g, "$1")
    .trim();

  if (/^<svg\b/i.test(svg) && !/^<svg\b[^>]*\sxmlns\s*=/i.test(svg)) {
    // Without it, the file does not render as an image.
    svg = svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return svg.replace(RESTORE, (_, i: string) => kept[Number(i)]!);
}

function minifyTag(tag: string, precision: number | null): string {
  if (tag.startsWith("</")) return tag.replace(/\s+/g, "");
  return tag
    .replace(/\s+/g, " ")
    .replace(/([\w:.-])\s*=\s*(?=["'])/g, "$1=")
    .replace(/([\w:.-]+)=("([^"]*)"|'([^']*)')/g, (whole, name: string, _q: string, double?: string, single?: string) => {
      if (!GEOMETRY_ATTRIBUTES.has(name)) return whole;
      const quote = double !== undefined ? '"' : "'";
      return `${name}=${quote}${minifyNumbers(double ?? single ?? "", name, precision)}${quote}`;
    })
    .replace(/\s+(\/?>)$/, "$1");
}

function minifyNumbers(value: string, name: string, precision: number | null): string {
  if (name === "d") return minifyPath(value, precision);
  if (name === "points") return joinCompact((value.match(NUMBER) ?? []).map((n) => formatNumber(n, precision)));
  return value.trim().replace(NUMBER, (n) => formatNumber(n, precision)).replace(/\s+/g, " ");
}

/**
 * Rewrites path data token by token, following each command's arity so that compact arc
 * flags ("a10 10 0 0110 10") are never read as numbers. Unparseable data is returned as is.
 */
function minifyPath(d: string, precision: number | null): string {
  const tokens: string[] = [];
  let command = "";
  let index = 0;
  let i = 0;
  const skipSeparators = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i++;
  };
  for (skipSeparators(); i < d.length; skipSeparators()) {
    const char = d[i]!;
    if (/[a-z]/i.test(char)) {
      if (!(char.toLowerCase() in PATH_ARITY)) return d;
      command = char.toLowerCase();
      index = 0;
      tokens.push(char);
      i++;
      continue;
    }
    const arity = PATH_ARITY[command];
    if (!arity) return d;
    const slot = index % arity;
    if (command === "a" && (slot === 3 || slot === 4)) {
      if (char !== "0" && char !== "1") return d;
      tokens.push(char);
      i++;
    } else {
      NUMBER_AT.lastIndex = i;
      const match = NUMBER_AT.exec(d);
      if (!match) return d;
      tokens.push(formatNumber(match[0], precision));
      i = NUMBER_AT.lastIndex;
    }
    index++;
  }
  return joinCompact(tokens);
}

/** Joins path tokens, with a space only where the next token would otherwise merge with the previous one. */
function joinCompact(tokens: readonly string[]): string {
  let out = "";
  let previous = "";
  for (const token of tokens) {
    const needsSpace =
      previous !== "" &&
      !/^[a-z]$/i.test(token) &&
      !/^[a-z]$/i.test(previous) &&
      !token.startsWith("-") &&
      !(token.startsWith(".") && /[.e]/i.test(previous));
    out += (needsSpace ? " " : "") + token;
    previous = token;
  }
  return out;
}

function formatNumber(raw: string, precision: number | null): string {
  if (/e/i.test(raw)) return raw;
  const rounded = precision !== null && raw.includes(".") ? String(Number(Number(raw).toFixed(precision))) : raw;
  return rounded
    .replace(/^\+/, "")
    .replace(/^(-?)0+(?=\d)/, "$1")
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "")
    .replace(/^(-?)0\./, "$1.")
    .replace(/^-0$/, "0");
}
