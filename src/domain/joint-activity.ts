/**
 * Sharing an activity's costs with another dispuut, as in the "Activiteiten" sheet:
 * ordinary costs are split by headcount; drinks with a weighting in which a member of the other
 * dispuut counts as `beerFactor` persons (1.5 = the usual 60/40). Headcounts may be fractional
 * (12.5: someone came briefly), so they are passed as integers in hundredths.
 * Exact integer arithmetic; each part is rounded to the cent once.
 */
import { cents, type Cents } from "./money";

/** "12,5" / "1.5" / "3" → integer hundredths (1250 / 150 / 300). No floats involved. */
export function parseHundredths(input: string): number {
  const s = input.trim().replace(",", ".");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Ongeldig getal: ${input}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

function divRound(num: number, den: number): number {
  // round half away from zero
  const q = Math.floor((2 * Math.abs(num) + den) / (2 * den));
  return num < 0 ? -q : q;
}

export interface JointShareInput {
  ours: number; // headcount ×100
  theirs: number; // headcount ×100
  normalCosts: Cents; // total of both disputen, split by headcount
  drinkCosts: Cents; // total of both disputen, split with the beer factor
  beerFactor: number; // ×100, e.g. 150
  paidByThem: Cents; // costs the other dispuut already paid
}

export interface JointShareResult {
  theirShare: Cents; // their part of all costs
  settle: Cents; // what they still owe us (negative: we owe them)
  ourShare: Cents;
}

export function jointShare(input: JointShareInput): JointShareResult {
  const { ours, theirs, beerFactor } = input;
  if (ours < 0 || theirs < 0 || beerFactor <= 0) throw new Error("Aantallen en verhouding moeten positief zijn");
  if (ours + theirs === 0) throw new Error("Vul het aantal deelnemers in");
  const normal = divRound(input.normalCosts * theirs, ours + theirs);
  // drinks: theirs×factor / (ours + theirs×factor); scale ours by 100 to match theirs×factor (×10⁴)
  const theirWeighted = theirs * beerFactor;
  const drinks = theirWeighted === 0 ? 0 : divRound(input.drinkCosts * theirWeighted, ours * 100 + theirWeighted);
  const theirShare = normal + drinks;
  return {
    theirShare: cents(theirShare),
    settle: cents(theirShare - input.paidByThem),
    ourShare: cents(input.normalCosts + input.drinkCosts - theirShare),
  };
}
