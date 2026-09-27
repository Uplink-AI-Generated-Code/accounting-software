import { describe, it, expect } from "vitest";
import cases from "../../tests/fixtures/decimal-cases.json";
import { stockPlaces } from "./stockMath";

describe("stockPlaces (shared fixture)", () => {
  it.each(cases.stockPlaces.map((c, i) => [i, c]))("case %i", (_i, c) => {
    const lines = c.lines.map((l) => (l.cashValue == null ? { amount: l.amount } : l));
    const opening = {
      ...(c.openingBalance != null ? { openingBalance: c.openingBalance } : {}),
      ...(c.openingBalanceCashValue != null ? { openingBalanceCashValue: c.openingBalanceCashValue } : {}),
    };
    expect(stockPlaces(c.cashScale, opening, lines)).toEqual({ moneyPlaces: c.money, unitPlaces: c.units, pricePlaces: c.price });
  });
});
