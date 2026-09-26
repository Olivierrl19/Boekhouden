/** A calendar date as `YYYY-MM-DD`. Booking dates are always LocalDates, never timestamps. */
export type LocalDate = string & { readonly __brand: "LocalDate" };

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function localDate(value: string): LocalDate {
  const m = LOCAL_DATE.exec(value);
  if (!m) throw new Error(`Invalid date (expected YYYY-MM-DD): ${value}`);
  const [, y, mo, d] = m.map(Number);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new Error(`Invalid calendar date: ${value}`);
  }
  return value as LocalDate;
}

export function isLocalDate(value: string): value is LocalDate {
  try {
    localDate(value);
    return true;
  } catch {
    return false;
  }
}

function parts(date: LocalDate): [number, number, number] {
  const [y, m, d] = date.split("-").map(Number);
  return [y, m, d];
}

function fromUtc(dt: Date): LocalDate {
  return dt.toISOString().slice(0, 10) as LocalDate;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [y, m, d] = parts(date);
  return fromUtc(new Date(Date.UTC(y, m - 1, d + days)));
}

export function firstOfMonth(date: LocalDate): LocalDate {
  const [y, m] = parts(date);
  return fromUtc(new Date(Date.UTC(y, m - 1, 1)));
}

export function addMonths(date: LocalDate, months: number): LocalDate {
  const [y, m, d] = parts(date);
  // Clamp to last day of target month.
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fromUtc(new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, lastDay))));
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Today in Europe/Amsterdam. */
export function todayAmsterdam(now: Date = new Date()): LocalDate {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now) as LocalDate;
}

/**
 * The fiscal year containing `date`, given the month (1-12) in which fiscal years start.
 * Example: startMonth 8, date 2026-09-26 → 2026-08-01 .. 2027-07-31, label "2026-2027".
 */
export function fiscalYearFor(
  date: LocalDate,
  startMonth: number,
): { startDate: LocalDate; endDate: LocalDate; label: string } {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new Error(`Invalid fiscal year start month: ${startMonth}`);
  }
  const [y, m] = parts(date);
  const startYear = m >= startMonth ? y : y - 1;
  const startDate = localDate(`${startYear}-${String(startMonth).padStart(2, "0")}-01`);
  const endDate = addDays(addMonths(startDate, 12), -1);
  const label = startMonth === 1 ? `${startYear}` : `${startYear}-${startYear + 1}`;
  return { startDate, endDate, label };
}

const MONTHS_NL = [
  "januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december",
];

export function formatDateNl(date: LocalDate): string {
  const [y, m, d] = parts(date);
  return `${d} ${MONTHS_NL[m - 1]} ${y}`;
}

export function formatMonthNl(date: LocalDate): string {
  const [y, m] = parts(date);
  return `${MONTHS_NL[m - 1]} ${y}`;
}
