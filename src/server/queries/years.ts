import { eq } from "drizzle-orm";
import { getDb, schema } from "../db";
import { currentFiscalYear } from "../auth/roles";

/** Resolve `?jaar=2025-2026` to a fiscal year, falling back to the current one. */
export async function yearFromParam(param: string | string[] | undefined) {
  if (typeof param === "string") {
    const [fy] = await getDb().select().from(schema.fiscalYears).where(eq(schema.fiscalYears.label, param));
    if (fy) return fy;
  }
  return currentFiscalYear();
}
