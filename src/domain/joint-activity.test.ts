import { describe, expect, it } from "vitest";
import { cents } from "./money";
import { jointShare, parseHundredths } from "./joint-activity";

describe("parseHundredths", () => {
  it("parses whole and fractional numbers without floats", () => {
    expect(parseHundredths("12,5")).toBe(1250);
    expect(parseHundredths("1.5")).toBe(150);
    expect(parseHundredths("3")).toBe(300);
    expect(parseHundredths("0,25")).toBe(25);
    expect(() => parseHundredths("1,234")).toThrow();
    expect(() => parseHundredths("-1")).toThrow();
  });
});

describe("jointShare (Activiteiten sheet)", () => {
  it("reproduces 'Borrel Meteoor intro': food by headcount, beer 60/40", () => {
    // 6 of ours, 14 of theirs; food 55.90 (we paid), beer 180.00 (they paid)
    const r = jointShare({ ours: 600, theirs: 1400, normalCosts: cents(5590), drinkCosts: cents(18000), beerFactor: 150, paidByThem: cents(18000) });
    expect(r.theirShare).toBe(3913 + 14000); // 39.13 food + 140.00 beer
    expect(r.settle).toBe(-87); // sheet: "Verrekenen" −0.87 for Weknow
    expect(r.ourShare).toBe(5677); // 16.77 + 40.00
  });
  it("reproduces 'NTF IV' with fractional headcount and costs on both sides", () => {
    // 8.4 ours, 11 theirs; dinner 67.34 − 0.22 split by headcount, beer 58.10 at 60/40
    const r = jointShare({ ours: 840, theirs: 1100, normalCosts: cents(6712), drinkCosts: cents(5810), beerFactor: 150, paidByThem: cents(-22) });
    expect(r.theirShare).toBe(3806 + 3850); // 38.06 + 38.50
    expect(r.settle).toBe(7678); // sheet: 76.78
  });
  it("needs participants", () => {
    expect(() => jointShare({ ours: 0, theirs: 0, normalCosts: cents(100), drinkCosts: cents(0), beerFactor: 150, paidByThem: cents(0) })).toThrow();
  });
});
