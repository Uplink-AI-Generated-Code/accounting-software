import { describe, it, expect, beforeAll } from "vitest";
import { fmt, fmtPlain, fmtUnits, fmtParts, maxPlaces, fracWidth, setCurrencyScales, setSymbolScales } from "./format";

beforeAll(() => {
  setCurrencyScales([{ code: "GBP", scale: 2 }, { code: "JPY", scale: 0 }, { code: "XBT", scale: 0 }, { code: "USDT", scale: 2 }]);
  setSymbolScales([{ ticker: "AAPL", tradingCurrency: "USD", scale: 6 }, { ticker: "TEST", tradingCurrency: "GBP", scale: 0 }]);
});

describe("fmt family: scale is the minimum, never a cap", () => {
  it("pads to the scale", () => {
    expect(fmt("20", "GBP")).toBe("£20.00");
    expect(fmt("-0.05", "GBP")).toBe("-£0.05");
    expect(fmt(undefined, "GBP")).toBe("£0.00");
    expect(fmtPlain("1500", "JPY")).toBe("1,500");
  });
  it("shows every stored digit beyond the scale, without rounding", () => {
    expect(fmt("123.4567", "GBP")).toBe("£123.4567");
    expect(fmtPlain("1234567890123456789.5", "GBP")).toBe("1,234,567,890,123,456,789.50");
    expect(fmtPlain("0.00012345", "XBT")).toBe("0.00012345");
    expect(fmtPlain("0.5", "XBT")).toBe("0.5");
  });
  it("uses the symbol scale as the minimum for units", () => {
    expect(fmtUnits("1.5", "AAPL:USD")).toBe("1.500000");
    expect(fmtUnits("3", "TEST:GBP")).toBe("3");
    expect(fmtUnits("0.12345", "TEST:GBP")).toBe("0.12345");
  });
  it("falls back to a prefixed code when Intl rejects the currency (e.g. a 4-letter code)", () => {
    expect(fmt("0.5", "USDT")).toBe("USDT 0.50");
  });
});

describe("alignment helpers", () => {
  it("splits a formatted amount at the decimal point", () => {
    expect(fmtParts("-1234.5", "GBP")).toEqual({ int: "-1,234", frac: ".50" });
    expect(fmtParts("20", "GBP", "currency")).toEqual({ int: "£20", frac: ".00" });
    expect(fmtParts("1500", "JPY")).toEqual({ int: "1,500", frac: "" });
    expect(fmtParts("0.12345", "TEST:GBP", "units")).toEqual({ int: "0", frac: ".12345" });
    expect(fmtParts("0.5", "USDT", "currency")).toEqual({ int: "USDT 0", frac: ".50" });
  });
  it("computes the widest displayed fraction", () => {
    expect(maxPlaces(2, ["20", "20.5", "123.4567", undefined, null])).toBe(4);
    expect(maxPlaces(0, [])).toBe(0);
    expect(fracWidth([{ value: "20", code: "GBP" }, { value: "20.5", code: "GBP" }])).toBe(2);
    expect(fracWidth([{ value: "20", code: "GBP" }, { value: "-123.4567", code: "GBP" }])).toBe(4);
    expect(fracWidth([{ value: "0.5", code: "XBT" }, { value: "0.00012345", code: "XBT" }])).toBe(8);
    expect(fracWidth([{ value: null, code: "GBP" }])).toBe(0);
    expect(fracWidth([{ value: "3", code: "TEST:GBP", kind: "units" }])).toBe(0);
  });
});
