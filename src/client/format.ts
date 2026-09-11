/** English number and size formatting for the workbench. */

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const NBSP = "\u00a0";

export function formatCount(value: number): string {
  return integer.format(value);
}

/** Decimal units (1 kB = 1,000 bytes), as browsers and operating systems display them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${integer.format(bytes)}${NBSP}byte${bytes === 1 ? "" : "s"}`;
  const units = ["kB", "MB", "GB"] as const;
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${decimal.format(value)}${NBSP}${units[unit]}`;
}

/** Relative change as a phrase: "52% smaller", "<1% larger" or, only when equal, "Same size". */
export function describeChange(before: number, after: number): { text: string; trend: "down" | "up" | "flat" } {
  if (after === before) return { text: "Same size", trend: "flat" };
  const percent = Math.round((Math.abs(after - before) / before) * 100);
  const amount = percent === 0 ? "<1" : integer.format(percent);
  return after < before ? { text: `${amount}% smaller`, trend: "down" } : { text: `${amount}% larger`, trend: "up" };
}
