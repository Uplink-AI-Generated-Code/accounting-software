import { describe, it, expect, beforeAll } from "vitest";
import { fmt, fmtPlain, fmtUnits, setCurrencyScales, setSymbolScales, precisionError } from "./format";

beforeAll(() => {
  setCurrencyScales([{ code: "GBP", scale: 2 }, { code: "JPY", scale: 0 }]);
  setSymbolScales([{ ticker: "AAPL", tradingCurrency: "USD", scale: 6 }]);
});

describe("fmt family (phase 1: exactly `scale` places)", () => {
  it("formats strings without going through a float", () => {
    expect(fmt("20", "GBP")).toBe("£20.00");
    expect(fmt("-0.05", "GBP")).toBe("-£0.05");
    expect(fmtPlain("1234567890123456789.5", "GBP")).toBe("1,234,567,890,123,456,789.50");
    expect(fmt(undefined, "GBP")).toBe("£0.00");
    expect(fmtPlain("1500", "JPY")).toBe("1,500");
  });
  it("trims units to the symbol's scale", () => {
    expect(fmtUnits("1.5", "AAPL:USD")).toBe("1.5");
  });
});

describe("precisionError (phase 1 only)", () => {
  const accounts = [
    { id: "c", type: "asset", currency: "GBP", name: "Cash" },
    { id: "i", type: "investment", symbolTicker: "AAPL", symbolCurrency: "USD", name: "Apple" },
  ];
  it("accepts values within scale", () => {
    expect(precisionError([{ accountId: "c", amount: "1.25" }], accounts)).toBeNull();
  });
  it("flags an amount deeper than its account's scale", () => {
    expect(precisionError([{ accountId: "c", amount: "1.255" }], accounts)).toMatch(/Cash/);
  });
});
