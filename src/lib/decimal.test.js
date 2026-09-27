import { describe, it, expect } from "vitest";
import cases from "../../tests/fixtures/decimal-cases.json";
import * as d from "./decimal";

describe("canonical (shared fixture)", () => {
  it.each(cases.canonical)("%s → %s", (input, expected) => {
    expect(d.canonical(input)).toBe(expected);
  });
  it.each(cases.invalid)("rejects %j", (input) => {
    expect(() => d.canonical(input)).toThrow();
    expect(d.parseDecimal(input)).toBeNull();
  });
});

describe("divide (shared fixture)", () => {
  it.each(cases.divide)("%s / %s = %s", (a, b, expected) => {
    expect(d.divide(a, b)).toBe(expected);
  });
});

describe("round (shared fixture)", () => {
  it.each(cases.round)("round(%s, %i) = %s", (x, places, expected) => {
    expect(d.round(x, places)).toBe(expected);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly, beyond float range", () => {
    expect(d.add("0.1", "0.2")).toBe("0.3");
    expect(d.add("9007199254740993", "1")).toBe("9007199254740994");
    expect(d.sub("1", "1")).toBe("0");
    expect(d.sub("0", "0.5")).toBe("-0.5");
  });
  it("multiplies, negates, takes abs and min", () => {
    expect(d.mul("1.5", "-2")).toBe("-3");
    expect(d.neg("0")).toBe("0");
    expect(d.neg("-2.5")).toBe("2.5");
    expect(d.abs("-2.5")).toBe("2.5");
    expect(d.min("3", "2.99")).toBe("2.99");
  });
  it("sums a list", () => {
    expect(d.sum([])).toBe("0");
    expect(d.sum(["1.1", "2.2", "-0.3"])).toBe("3");
  });
});

describe("comparisons and predicates", () => {
  it("compares", () => {
    expect(d.cmp("2", "10")).toBe(-1);
    expect(d.cmp("-1", "-1")).toBe(0);
    expect(d.sign("-0.01")).toBe(-1);
    expect(d.isZero("0")).toBe(true);
  });
  it("treats missing values as zero in the tolerant predicates", () => {
    expect(d.isNegative(undefined)).toBe(false);
    expect(d.isPositive(null)).toBe(false);
    expect(d.isNonZero(undefined)).toBe(false);
    expect(d.isNonZero("0.001")).toBe(true);
    expect(d.isNegative("-3")).toBe(true);
  });
});

describe("parsing helpers", () => {
  it("parseOrZero falls back to zero", () => {
    expect(d.parseOrZero("")).toBe("0");
    expect(d.parseOrZero("abc")).toBe("0");
    expect(d.parseOrZero(" 12.50 ")).toBe("12.5");
  });
  it("counts fraction digits of a canonical string", () => {
    expect(d.fractionDigits("12")).toBe(0);
    expect(d.fractionDigits("-0.125")).toBe(3);
  });
});

describe("renderer boundary", () => {
  it("converts to and from numbers", () => {
    expect(d.toNumber("12.5")).toBe(12.5);
    expect(d.fromNumber(1500)).toBe("1500");
    expect(d.fromNumber(1e-7)).toBe("0.0000001");
    expect(d.fromNumber(NaN)).toBe("0");
  });
  it("refuses a raw Number anywhere else", () => {
    expect(() => d.add(1, "2")).toThrow();
  });
});
