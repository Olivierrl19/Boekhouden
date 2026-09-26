"use server";

import { timingSafeEqual } from "node:crypto";
import { redirect, unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/server/db";
import { installAssociation, isSetupCompleted, wipeDemo } from "@/server/services/install";
import { eq } from "drizzle-orm";
import { schema } from "@/server/db";
import { startSessionFor } from "@/server/auth/direct-login";
import { seed } from "@/server/db/seed";
import { errorMessage } from "@/server/errors";
import { parseEuroString, cents } from "@/domain/money";
import { localDate } from "@/domain/dates";

function checkCode(given: FormDataEntryValue | null): string | null {
  const expected = process.env.SETUP_CODE;
  if (!expected) return "SETUP_CODE is niet ingesteld (zie de uitleg op deze pagina).";
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return "De installatiecode klopt niet.";
  return null;
}

function fail(message: string): never {
  redirect(`/setup?fout=${encodeURIComponent(message)}`);
}

const euro = z
  .string()
  .trim()
  .transform((s, ctx) => {
    if (s === "") return cents(0);
    try {
      return parseEuroString(s);
    } catch {
      ctx.addIssue({ code: "custom", message: `Ongeldig bedrag: ${s}` });
      return z.NEVER;
    }
  });

const InstallSchema = z.object({
  name: z.string().trim().min(2, "Vul de naam van het dispuut in"),
  firstName: z.string().trim().min(1, "Vul je voornaam in"),
  lastName: z.string().trim().min(1, "Vul je achternaam in"),
  email: z.string().trim().toLowerCase().email("Vul een geldig e-mailadres in"),
  startMonth: z.coerce.number().int().min(1).max(12),
  startDate: z.string().refine((s) => {
    try {
      localDate(s);
      return true;
    } catch {
      return false;
    }
  }, "Ongeldige startdatum"),
  memberTypeName: z.string().trim().min(1).default("Lid"),
  contribution: euro,
  checkingIban: z.string().trim().min(1, "Vul het IBAN van de betaalrekening in"),
  checkingBalance: euro,
  savingsIban: z.string().trim().optional(),
  savingsBalance: euro,
  cashBalance: euro,
});

export async function installAction(formData: FormData) {
  const codeError = checkCode(formData.get("code"));
  if (codeError) fail(codeError);
  const parsed = InstallSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) fail(parsed.error.issues[0]?.message ?? "Controleer de invoer");
  const v = parsed.data;

  let fiscusUserId: string;
  try {
    const db = getDb();
    if (await isSetupCompleted(db)) fail("Het dispuut is al ingericht.");
    const result = await db.transaction((tx) =>
      installAssociation(
        tx,
        {
          name: v.name,
          shortName: v.name,
          fiscalYearStartMonth: v.startMonth,
          startDate: localDate(v.startDate),
          fiscus: { firstName: v.firstName, lastName: v.lastName, email: v.email },
          memberType: { name: v.memberTypeName, monthlyContribution: v.contribution },
          checking: { iban: v.checkingIban, openingBalance: v.checkingBalance },
          savings: v.savingsIban ? { iban: v.savingsIban, openingBalance: v.savingsBalance } : null,
          cashOpeningBalance: v.cashBalance,
        },
        { userId: null },
      ),
    );
    fiscusUserId = result.fiscusUserId;
  } catch (err) {
    unstable_rethrow(err);
    fail(errorMessage(err));
  }
  await startSessionFor(fiscusUserId);
  redirect("/");
}

export async function demoAction(formData: FormData) {
  const codeError = checkCode(formData.get("code"));
  if (codeError) fail(codeError);
  try {
    const db = getDb();
    if (await isSetupCompleted(db)) fail("Het dispuut is al ingericht.");
    await seed(db);
  } catch (err) {
    unstable_rethrow(err);
    fail(errorMessage(err));
  }
  // Log straight in as the demo fiscus, so no e-mail is needed to look around.
  const [sanne] = await getDb().select().from(schema.users).where(eq(schema.users.email, "sanne@dispuut-demo.nl"));
  await startSessionFor(sanne.id);
  redirect("/");
}

export async function wipeDemoAction(formData: FormData) {
  const codeError = checkCode(formData.get("code"));
  if (codeError) redirect(`/demo-wissen?fout=${encodeURIComponent(codeError)}`);
  try {
    await getDb().transaction((tx) => wipeDemo(tx));
  } catch (err) {
    unstable_rethrow(err);
    redirect(`/demo-wissen?fout=${encodeURIComponent(errorMessage(err))}`);
  }
  redirect("/setup");
}
