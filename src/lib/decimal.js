import Big from "big.js";

// The one place amounts are parsed, normalized, and computed on — see
// CLAUDE.md's "Amounts". Every export takes and returns *canonical*
// decimal strings (no "+", no leading zeros, no trailing fractional
// zeros, never "-0"), so React state, props, === and JSON all stay plain
// strings and string equality is numeric equality. Nothing outside this
// file ever holds a big.js object.

// A private constructor so these settings can't leak into, or be changed
// by, any other importer of big.js.
const D = Big();
export const DIVISION_PLACES = 20;
D.DP = DIVISION_PLACES;
D.RM = Big.roundHalfUp; // half away from zero — same as the backend
D.strict = true; // a raw Number is always a bug here: amounts are strings

// What a person may type: optional sign, digits, optional point. No
// exponents, no thousands separators.
const INPUT_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function out(b) {
  const s = b.toFixed();
  return s === "-0" ? "0" : s;
}

export function parseDecimal(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!INPUT_RE.test(s)) return null;
  return out(new D(s.startsWith("+") ? s.slice(1) : s));
}

export function parseOrZero(input) {
  return parseDecimal(input) ?? "0";
}

export function canonical(x) {
  const c = parseDecimal(x);
  if (c === null) throw new Error(`Not a decimal amount: ${JSON.stringify(x)}`);
  return c;
}

export const add = (a, b) => out(new D(a).plus(b));
export const sub = (a, b) => out(new D(a).minus(b));
export const mul = (a, b) => out(new D(a).times(b));
export const neg = (a) => out(new D(a).neg());
export const abs = (a) => out(new D(a).abs());
export const cmp = (a, b) => new D(a).cmp(b);
export const sign = (a) => new D(a).cmp("0");
export const isZero = (a) => new D(a).eq("0");
export const min = (a, b) => (cmp(a, b) <= 0 ? a : b);
export const sum = (list) => list.reduce((acc, x) => add(acc, x), "0");

// The ONLY division of amounts in the frontend — keeping every division
// behind this one helper is what keeps a future switch to exact
// fractions cheap (see the spec). 20 dp, half away from zero; a zero
// divisor yields "0", same contract the old divRoundHalfUp() had.
export function divide(a, b) {
  if (isZero(b)) return "0";
  return out(new D(a).div(b));
}

export function round(x, places) {
  return out(new D(x).round(places, Big.roundHalfUp));
}

// Tolerant predicates for display code, where a missing field (an
// omitted nullable amount) just means zero.
export const isNegative = (x) => x != null && sign(x) < 0;
export const isPositive = (x) => x != null && sign(x) > 0;
export const isNonZero = (x) => x != null && !isZero(x);

export function fractionDigits(x) {
  const i = x.indexOf(".");
  return i === -1 ? 0 : x.length - i - 1;
}

// Renderer boundary ONLY (Recharts data/ticks, a CSS width, Intl
// significant-digit formatting of a display-only ratio). Never use these
// to do arithmetic on an amount.
export function toNumber(x) {
  return Number(x);
}
export function fromNumber(n) {
  return Number.isFinite(n) ? out(new D(String(n))) : "0";
}
