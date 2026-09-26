import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocate, cents, centsFromDb, formatEuro, MoneyError, parseEuroString, sum } from "./money";

describe("parseEuroString", () => {
  it.each([
    ["+12,50", 1250],
    ["-12,50", -1250],
    ["1.234,56", 123456],
    ["-1.234.567,89", -123456789],
    ["12", 1200],
    ["0,05", 5],
    ["0,5", 50],
    ["1234.56", 123456],
    ["1,234.56", 123456],
    ["1.234", 123400],
    ["€ 7,00", 700],
    ["−3,10", -310],
  ])("%s → %d", (input, expected) => {
    expect(parseEuroString(input)).toBe(expected);
  });

  it.each(["", "abc", "1,2,3", "12,345", "1.23.4", "1..2", "12,5a", "1.2345,00"])(
    "rejects %s",
    (input) => {
      expect(() => parseEuroString(input)).toThrow(MoneyError);
    },
  );

  it("round-trips any amount through Dutch formatting", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e13, max: 1e13 }), (n) => {
        const formatted = formatEuro(cents(n)).replace("€ ", "");
        expect(parseEuroString(formatted)).toBe(n);
      }),
    );
  });
});

describe("cents", () => {
  it("rejects floats and unsafe integers", () => {
    expect(() => cents(0.1)).toThrow(MoneyError);
    expect(() => cents(Number.MAX_SAFE_INTEGER + 1)).toThrow(MoneyError);
  });
  it("reads db strings", () => {
    expect(centsFromDb("-1234")).toBe(-1234);
    expect(centsFromDb(null)).toBe(0);
    expect(() => centsFromDb("12.5")).toThrow(MoneyError);
  });
});

describe("formatEuro", () => {
  it("formats Dutch style", () => {
    expect(formatEuro(cents(123456))).toBe("€ 1.234,56");
    expect(formatEuro(cents(-5))).toBe("-€ 0,05");
    expect(formatEuro(cents(1000), { sign: true })).toBe("+€ 10,00");
  });
});

describe("allocate", () => {
  it("splits 100,00 over three equally with the extra cent first", () => {
    expect(allocate(cents(10000), [1, 1, 1])).toEqual([3334, 3333, 3333]);
  });

  it("handles weights and negative totals", () => {
    expect(allocate(cents(1000), [3, 1])).toEqual([750, 250]);
    expect(allocate(cents(-10000), [1, 1, 1])).toEqual([-3334, -3333, -3333]);
  });

  it("never gives cents to a zero weight", () => {
    expect(allocate(cents(101), [0, 1, 1])).toEqual([0, 51, 50]);
  });

  it("refuses to allocate over nothing", () => {
    expect(() => allocate(cents(1), [])).toThrow(MoneyError);
    expect(() => allocate(cents(1), [0, 0])).toThrow(MoneyError);
    expect(allocate(cents(0), [0, 0])).toEqual([0, 0]);
  });

  it("property: parts always sum exactly to the total and stay within one cent of fair", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e12, max: 1e12 }),
        fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 60 }).filter((w) => w.some((x) => x > 0)),
        (total, weights) => {
          const parts = allocate(cents(total), weights);
          expect(sum(parts)).toBe(total);
          const wSum = weights.reduce((a, b) => a + b, 0);
          parts.forEach((p, i) => {
            const fair = (total * weights[i]) / wSum;
            expect(Math.abs(p - fair)).toBeLessThan(1);
            if (weights[i] === 0) expect(p).toBe(0);
          });
        },
      ),
    );
  });
});
