// Safe, no-float-drift conversion between the API's scaled-integer
// amounts and the decimal strings a human types/reads — see CLAUDE.md.
// `scale` is the number of decimal places an amount is stored with (2
// for GBP, 6 for a stock symbol's units, 0 for JPY, etc.) — never assume
// 2, it's always data-driven (from a Currency's or Symbol's own `scale`).

// Parses a typed decimal string into a scaled integer without ever going
// through a float intermediate. Returns NaN for anything unparseable —
// deliberately mirroring parseFloat()'s NaN-on-failure contract, so
// existing `isNaN(x) ? 0 : x` call sites don't need to change shape, only
// swap which parser they call.
export function toMinorUnits(str, scale) {
  if (str === null || str === undefined) return NaN;
  const s = String(str).trim();
  if (s === "" || s === "-" || !/^-?\d*\.?\d*$/.test(s)) return NaN;
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [wholeRaw, fracRaw = ""] = body.split(".");
  if (wholeRaw === "" && fracRaw === "") return NaN;
  const whole = wholeRaw || "0";
  const frac = fracRaw.slice(0, scale).padEnd(scale, "0");
  const digits = (whole + frac).replace(/^0+(?=\d)/, "");
  const n = BigInt(digits || "0");
  return Number(neg && n !== 0n ? -n : n);
}

// Inverse: formats a scaled integer back into a plain, minimal decimal
// string suitable for an <input> field (no thousands separators, no
// currency symbol, no padded trailing zeros — see format.js's fmt() for
// display formatting, which is a different job).
export function fromMinorUnits(value, scale) {
  if (!Number.isFinite(value)) return "";
  const n = BigInt(Math.round(value));
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const factor = 10n ** BigInt(scale);
  const whole = abs / factor;
  const frac = (abs % factor).toString().padStart(scale, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}

// Exact integer division with round-half-up, mirrored exactly from the
// backend's LedgerStateService::divRoundHalfUp() — see CLAUDE.md. Used
// wherever cost-basis/portfolio-value math needs to divide two scaled
// integers; a cross-multiply-then-divide keeps every intermediate value
// an exact integer of the correct implied scale without either side
// needing to know the scale explicitly.
export function divRoundHalfUp(numerator, denominator) {
  const den = BigInt(Math.round(denominator));
  if (den === 0n) return 0;
  const num = BigInt(Math.round(numerator));
  const sign = (num < 0n) !== (den < 0n) ? -1n : 1n;
  const n = num < 0n ? -num : num;
  const d = den < 0n ? -den : den;
  return Number(sign * ((2n * n + d) / (2n * d)));
}
