import { connection } from "next/server";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db";
import { isSetupCompleted } from "@/server/services/install";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SubmitButton } from "@/components/submit-button";
import { fiscalYearFor, todayAmsterdam } from "@/domain/dates";
import { demoAction, installAction } from "./actions";

// The demo fills a whole year of bookings; give it time on serverless hosting.
export const maxDuration = 300;

const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function Field({ label, name, hint, ...props }: { label: string; name: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} {...props} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default async function SetupPage({ searchParams }: PageProps<"/setup">) {
  await connection();
  if (await isSetupCompleted(getDb())) redirect("/");
  const { fout } = await searchParams;
  const codeConfigured = !!process.env.SETUP_CODE;
  const mailConfigured = !!process.env.EMAIL_SERVER;
  const defaultStart = fiscalYearFor(todayAmsterdam(), 8).startDate;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-4 py-10">
      <div>
        <h1 className="text-2xl font-semibold">Dispuut inrichten</h1>
        <p className="text-sm text-muted-foreground">
          Dit doe je één keer. Daarna ben je ingelogd als fiscus en kun je leden toevoegen.
        </p>
      </div>

      {!codeConfigured && (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/40">
          <CardContent className="p-5 text-sm">
            Stel eerst bij je hosting (Vercel → Settings → Environment Variables) een variabele{" "}
            <code className="font-mono">SETUP_CODE</code> in met een zelfgekozen geheime code, en deploy opnieuw. Zo kan
            alleen jij het dispuut inrichten.
          </CardContent>
        </Card>
      )}
      {!mailConfigured && (
        <Card className="border-amber-300 bg-amber-50 dark:bg-amber-950/40">
          <CardContent className="p-5 text-sm">
            Er is nog geen e-mail ingesteld (<code className="font-mono">EMAIL_SERVER</code>). Je wordt na het inrichten
            direct ingelogd, maar leden kunnen pas inloggen als e-mail is ingesteld (zie README).
          </CardContent>
        </Card>
      )}
      {typeof fout === "string" && (
        <Card className="border-red-300 bg-red-50 dark:bg-red-950/40">
          <CardContent className="p-5 text-sm text-red-800 dark:text-red-300">{fout}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Nieuw dispuut</CardTitle>
          <CardDescription>Bedragen mag je invullen als 1234,56. Leeg laten = € 0,00.</CardDescription>
        </CardHeader>
        <CardContent>
          <form action={installAction} className="flex flex-col gap-6">
            <Field label="Installatiecode" name="code" type="password" required hint="De SETUP_CODE die je bij Vercel hebt ingesteld." />

            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="mb-2 font-medium">Het dispuut</legend>
              <div className="sm:col-span-2">
                <Field label="Naam dispuut" name="name" required placeholder="Dispuut ..." />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="startMonth">Boekjaar begint in</Label>
                <select id="startMonth" name="startMonth" defaultValue="8" className="h-9 rounded-md border border-input bg-transparent px-3 text-sm">
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>{m}</option>
                  ))}
                </select>
              </div>
              <Field label="Startdatum boekhouding" name="startDate" type="date" required defaultValue={defaultStart} hint="Meestal de eerste dag van het boekjaar." />
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="mb-2 font-medium">Jij (fiscus)</legend>
              <Field label="Voornaam" name="firstName" required />
              <Field label="Achternaam" name="lastName" required />
              <div className="sm:col-span-2">
                <Field label="E-mailadres" name="email" type="email" required hint="Hiermee log je later in." />
              </div>
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="mb-2 font-medium">Contributie</legend>
              <Field label="Soort lid" name="memberTypeName" defaultValue="Lid" required hint="Meer soorten kun je later toevoegen." />
              <Field label="Contributie per maand" name="contribution" inputMode="decimal" placeholder="15,00" />
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="mb-2 font-medium">Beginsaldi op de startdatum</legend>
              <p className="-mt-2 text-xs text-muted-foreground sm:col-span-2">
                Het saldo aan het begin van de startdatum, zoals in je bankapp. De eerste bankimport moet hierop aansluiten.
              </p>
              <Field label="IBAN betaalrekening" name="checkingIban" required placeholder="NL.. RABO .... .... .." />
              <Field label="Saldo betaalrekening" name="checkingBalance" inputMode="decimal" placeholder="0,00" />
              <Field label="IBAN spaarrekening (optioneel)" name="savingsIban" placeholder="NL.. RABO .... .... .." />
              <Field label="Saldo spaarrekening" name="savingsBalance" inputMode="decimal" placeholder="0,00" />
              <Field label="Saldo kas (contant)" name="cashBalance" inputMode="decimal" placeholder="0,00" />
            </fieldset>

            <SubmitButton pendingText="Bezig met inrichten…">Dispuut inrichten</SubmitButton>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Eerst rondkijken?</CardTitle>
          <CardDescription>
            Vul de app met een voorbeelddispuut (44 leden, een afgesloten en een lopend boekjaar). Dit duurt ongeveer een
            minuut. Wil je daarna echt beginnen, maak dan een nieuwe lege database aan (zie README).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={demoAction} className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="Installatiecode" name="code" type="password" required />
            </div>
            <SubmitButton variant="outline" pendingText="Voorbeelddispuut wordt gevuld…">Voorbeelddispuut laden</SubmitButton>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
