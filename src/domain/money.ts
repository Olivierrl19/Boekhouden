/**
 * Money is always an integer number of euro cents.
 *
 * `Cents` is a branded number so that a plain `number` (which might be euros, or a float)
 * cannot silently be passed where cents are expected. Values are always safe integers.
 */
export type Cents = number & { readonly __brand: "Cents" };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/** Wrap a number as Cents, asserting it is a safe integer. */
export function cents(value: number): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`Not a safe integer amount of cents: ${value}`);
  }
  // Normalise -0 to 0 so equality checks and formatting behave.
  return (value === 0 ? 0 : value) as Cents;
}

export const ZERO = cents(0);

export function add(...values: Cents[]): Cents {
  let total = 0;
  for (const v of values) total += v;
  return cents(total);
}

export function sum(values: readonly Cents[]): Cents {
  return add(...values);
}

export function negate(value: Cents): Cents {
  return cents(-value);
}

export function subtract(a: Cents, b: Cents): Cents {
  return cents(a - b);
}

export function abs(value: Cents): Cents {
  return cents(Math.abs(value));
}

/**
 * Parse a database value (postgres returns bigint/numeric sums as strings) into Cents.
 * Rejects anything that is not an integer.
 */
export function centsFromDb(value: string | number | bigint | null | undefined): Cents {
  if (value === null || value === undefined) return ZERO;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new MoneyError(`Amount out of safe range: ${value}`);
    }
    return cents(Number(value));
  }
  if (typeof value === "number") return cents(value);
  if (!/^-?\d+$/.test(value)) {
    throw new MoneyError(`Database amount is not an integer: ${value}`);
  }
  return centsFromDb(BigInt(value));
}

/**
 * Parse a human/bank euro string into cents without floating point arithmetic.
 *
 * Accepts Dutch notation ("1.234,56", "+12,50", "-0,05", "12") and plain dot-decimal
 * notation ("1234.56") as long as it is unambiguous. At most two decimals.
 */
export function parseEuroString(input: string): Cents {
  let s = input.trim().replace(/\s/g, "").replace(/^€/, "").replace(/€$/, "");
  if (s === "") throw new MoneyError("Empty amount");

  let sign = 1;
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("-") || s.startsWith("−")) {
    sign = -1;
    s = s.slice(1);
  }

  let integerPart: string;
  let fractionPart = "";

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the last one is the decimal separator, the other is thousands.
    const decimalSep = lastComma > lastDot ? "," : ".";
    const thousandsSep = decimalSep === "," ? "." : ",";
    const [i, f, ...rest] = s.split(decimalSep);
    if (rest.length > 0) throw new MoneyError(`Invalid amount: ${input}`);
    integerPart = validateThousands(i, thousandsSep, input);
    fractionPart = f;
  } else if (lastComma >= 0) {
    const parts = s.split(",");
    if (parts.length !== 2) throw new MoneyError(`Invalid amount: ${input}`);
    [integerPart, fractionPart] = parts;
  } else if (lastDot >= 0) {
    const parts = s.split(".");
    if (parts.length === 2 && parts[1].length <= 2) {
      [integerPart, fractionPart] = parts;
    } else {
      // "1.234" or "1.234.567": dots are thousands separators.
      integerPart = validateThousands(s, ".", input);
    }
  } else {
    integerPart = s;
  }

  if (!/^\d+$/.test(integerPart) || !/^\d{0,2}$/.test(fractionPart)) {
    throw new MoneyError(`Invalid amount: ${input}`);
  }
  const fraction = fractionPart.padEnd(2, "0");
  const total = BigInt(integerPart) * BigInt(100) + BigInt(fraction);
  return centsFromDb(BigInt(sign) * total);
}

function validateThousands(value: string, sep: string, original: string): string {
  const groups = value.split(sep);
  if (groups.length > 1) {
    const [first, ...rest] = groups;
    if (!/^\d{1,3}$/.test(first) || rest.some((g) => !/^\d{3}$/.test(g))) {
      throw new MoneyError(`Invalid thousands grouping: ${original}`);
    }
  }
  return groups.join("");
}

/** Format cents as a Dutch euro string, e.g. "€ 1.234,56" / "-€ 12,50". */
export function formatEuro(value: Cents, opts: { sign?: boolean } = {}): string {
  const negative = value < 0;
  const absolute = Math.abs(value);
  const euros = Math.floor(absolute / 100);
  const rest = absolute % 100;
  const grouped = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const body = `€ ${grouped},${rest.toString().padStart(2, "0")}`;
  if (negative) return `-${body}`;
  if (opts.sign && value > 0) return `+${body}`;
  return body;
}

/** Format cents as a plain decimal string with a dot, for exports ("-1234.56"). */
export function formatDecimal(value: Cents): string {
  const negative = value < 0;
  const absolute = Math.abs(value);
  return `${negative ? "-" : ""}${Math.floor(absolute / 100)}.${(absolute % 100)
    .toString()
    .padStart(2, "0")}`;
}

/**
 * Split `total` over parts proportionally to non-negative integer `weights`, using the
 * largest remainder method, so that the parts always add up to exactly `total`.
 *
 * Ties are broken by position (earlier weight wins), which makes the result deterministic.
 * Works for negative totals by allocating the absolute value and negating.
 */
export function allocate(total: Cents, weights: readonly number[]): Cents[] {
  if (weights.length === 0) {
    if (total === 0) return [];
    throw new MoneyError("Cannot allocate a non-zero amount over zero parts");
  }
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) {
      throw new MoneyError(`Weights must be non-negative integers, got ${w}`);
    }
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) {
    if (total === 0) return weights.map(() => ZERO);
    throw new MoneyError("Cannot allocate a non-zero amount when all weights are zero");
  }

  const negative = total < 0;
  const amount = BigInt(Math.abs(total));
  const wSum = BigInt(weightSum);

  // BigInt arithmetic: amount * weight can exceed 2^53 for large totals.
  const floors = weights.map((w) => (amount * BigInt(w)) / wSum);
  const remainders = weights.map((w, i) => ({
    index: i,
    remainder: (amount * BigInt(w)) % wSum,
  }));
  let leftover = amount - floors.reduce((a, b) => a + b, BigInt(0));

  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  const result = [...floors];
  for (const { index } of remainders) {
    if (leftover === BigInt(0)) break;
    if (weights[index] === 0) continue;
    result[index] += BigInt(1);
    leftover -= BigInt(1);
  }

  return result.map((v) => cents(Number(negative ? -v : v)));
}
