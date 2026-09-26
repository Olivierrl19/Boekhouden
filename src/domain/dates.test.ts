import { describe, expect, it } from "vitest";
import { addMonths, fiscalYearFor, firstOfMonth, localDate, todayAmsterdam } from "./dates";

describe("dates", () => {
  it("validates calendar dates", () => {
    expect(() => localDate("2026-02-30")).toThrow();
    expect(() => localDate("26-02-01")).toThrow();
    expect(localDate("2028-02-29")).toBe("2028-02-29");
  });

  it("computes the fiscal year starting in August", () => {
    expect(fiscalYearFor(localDate("2026-09-26"), 8)).toEqual({
      startDate: "2026-08-01",
      endDate: "2027-07-31",
      label: "2026-2027",
    });
    expect(fiscalYearFor(localDate("2026-07-31"), 8).label).toBe("2025-2026");
    expect(fiscalYearFor(localDate("2026-08-01"), 8).label).toBe("2026-2027");
  });

  it("uses the plain year as label for calendar years", () => {
    expect(fiscalYearFor(localDate("2026-05-01"), 1)).toEqual({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
      label: "2026",
    });
  });

  it("adds months with clamping", () => {
    expect(addMonths(localDate("2026-01-31"), 1)).toBe("2026-02-28");
    expect(firstOfMonth(localDate("2026-09-26"))).toBe("2026-09-01");
  });

  it("knows today in Amsterdam across the date line", () => {
    expect(todayAmsterdam(new Date("2026-09-26T22:30:00Z"))).toBe("2026-09-27");
  });
});
