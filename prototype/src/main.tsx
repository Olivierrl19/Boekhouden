import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cents, parseEuroString } from "@/domain/money";
import { fiscalYearFor, localDate } from "@/domain/dates";
import { LedgerStore, migrateState, today, type Actor, type State } from "./ledger";
import { createDemoState } from "./demo";
import { App } from "./ui/app";
import { Field, Select } from "./ui/core";
import "./styles.css";

const KEY = "boekhouding-prototype-v1";

function load(): State | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? migrateState(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

let warned = false;
function persist(state: State) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    if (!warned) {
      warned = true;
      alert("De browser kan de gegevens niet (meer) opslaan: de opslag is vol of uitgeschakeld (bijv. privévenster). Maak een back-up via 'Back-up'.");
    }
  }
}

function makeStore(state: State) {
  return new LedgerStore(state, persist);
}

function Root() {
  const [store, setStore] = useState<LedgerStore | null>(() => {
    const s = load();
    return s ? makeStore(s) : null;
  });
  const reset = () => {
    try { localStorage.removeItem(KEY); localStorage.removeItem("boekhouding-actor"); } catch { /* ignore */ }
    window.location.hash = "#/";
    setStore(null);
  };
  if (!store) return <Welcome onStart={(s) => { persist(s); window.location.hash = "#/"; setStore(makeStore(s)); }} />;
  return <App store={store} onReset={reset} />;
}

const MONTHS = ["januari", "februari", "maart", "april", "mei", "juni", "juli", "augustus", "september", "oktober", "november", "december"];

function Welcome({ onStart }: { onStart: (s: State) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", firstName: "", lastName: "", email: "", startMonth: "8", startDate: fiscalYearFor(today(), 8).startDate as string, checkingIban: "", checking: "", savingsIban: "", savings: "", cash: "", typeName: "Lid", monthly: "15,00" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const amount = (v: string) => (v.trim() ? parseEuroString(v) : cents(0));

  const startOwn = () => {
    setError(null);
    try {
      if (!f.name.trim()) throw new Error("Vul de naam van het dispuut in");
      if (!f.firstName.trim() || !f.lastName.trim()) throw new Error("Vul je naam in");
      const initial = LedgerStore.install({ name: f.name.trim(), fiscalYearStartMonth: Number(f.startMonth), startDate: localDate(f.startDate), checkingIban: f.checkingIban, savingsIban: f.savingsIban.trim() || null });
      const store = new LedgerStore(initial);
      const fiscus: Actor = { role: "fiscus", partyId: null, label: `${f.firstName} ${f.lastName} (fiscus)` };
      store.batch(() => {
        const type = store.createMemberType({ name: f.typeName, monthly: amount(f.monthly) }, fiscus);
        store.createMember({ firstName: f.firstName, lastName: f.lastName, email: f.email, memberTypeId: type.id, joinedOn: localDate(f.startDate) }, fiscus);
        const banks = store.getState().bankAccounts;
        store.setOpeningBalance({
          date: localDate(f.startDate),
          bank: [
            { bankAccountId: banks.find((b) => b.kind === "checking")!.id, amount: amount(f.checking) },
            ...(f.savingsIban.trim() ? [{ bankAccountId: banks.find((b) => b.kind === "savings")!.id, amount: amount(f.savings) }] : []),
            { bankAccountId: banks.find((b) => b.kind === "cash")!.id, amount: amount(f.cash) },
          ],
        }, fiscus);
      });
      onStart(store.getState());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const startBackup = async (file: File) => {
    try {
      onStart(migrateState(JSON.parse(await file.text())));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-4 py-10">
      <div className="flex items-center gap-3">
        <BookOpen className="size-8" />
        <div>
          <h1 className="text-2xl font-semibold">Boekhouding voor het dispuut</h1>
          <p className="text-sm text-muted-foreground">Prototype. Werkt helemaal in je browser: niets installeren, geen account, gratis. Gegevens blijven op deze computer.</p>
        </div>
      </div>
      {error && <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">{error}</div>}
      <Card className="border-sky-300">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Sparkles className="size-5 text-sky-600" /> Rondkijken met een voorbeelddispuut</CardTitle>
          <CardDescription>32 leden, een afgesloten en een lopend boekjaar, borrels, een feest met een ander dispuut, declaraties en een paar bankregels die nog toegewezen moeten worden.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button disabled={busy} onClick={() => { setBusy(true); setTimeout(() => { try { onStart(createDemoState(today())); } catch (err) { setError((err as Error).message); setBusy(false); } }, 20); }}>
            {busy ? "Bezig met vullen…" : "Start voorbeelddispuut"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Eigen dispuut beginnen</CardTitle><CardDescription>Bedragen als 1234,56. Leeg = € 0,00. Leden, soorten leden en activiteiten voeg je daarna toe.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Naam dispuut" className="sm:col-span-2"><Input value={f.name} onChange={set("name")} /></Field>
          <Field label="Jouw voornaam (fiscus)"><Input value={f.firstName} onChange={set("firstName")} /></Field>
          <Field label="Achternaam"><Input value={f.lastName} onChange={set("lastName")} /></Field>
          <Field label="E-mail"><Input type="email" value={f.email} onChange={set("email")} /></Field>
          <Field label="Boekjaar begint in"><Select value={f.startMonth} onChange={(e) => setF({ ...f, startMonth: e.target.value, startDate: fiscalYearFor(today(), Number(e.target.value)).startDate })}>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
          <Field label="Startdatum boekhouding" hint="Saldi hieronder zijn het saldo aan het begin van deze dag"><Input type="date" value={f.startDate} onChange={set("startDate")} /></Field>
          <Field label="Soort lid / contributie per maand"><div className="flex gap-2"><Input value={f.typeName} onChange={set("typeName")} /><Input value={f.monthly} onChange={set("monthly")} className="w-24" /></div></Field>
          <Field label="IBAN betaalrekening"><Input value={f.checkingIban} onChange={set("checkingIban")} placeholder="NL.. RABO .." /></Field>
          <Field label="Saldo betaalrekening"><Input value={f.checking} onChange={set("checking")} placeholder="0,00" /></Field>
          <Field label="IBAN spaarrekening (optioneel)"><Input value={f.savingsIban} onChange={set("savingsIban")} /></Field>
          <Field label="Saldo spaarrekening"><Input value={f.savings} onChange={set("savings")} placeholder="0,00" /></Field>
          <Field label="Saldo kas"><Input value={f.cash} onChange={set("cash")} placeholder="0,00" /></Field>
          <div className="sm:col-span-2"><Button onClick={startOwn}>Dispuut aanmaken</Button></div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Back-up openen</CardTitle><CardDescription>Heb je al een back-up (.json)? Open die hier, bijvoorbeeld op een andere computer.</CardDescription></CardHeader>
        <CardContent>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-4 py-2 text-sm hover:bg-accent"><Upload className="size-4" /> Kies back-upbestand<input type="file" accept=".json" className="hidden" onChange={(e) => e.target.files?.[0] && startBackup(e.target.files[0])} /></label>
        </CardContent>
      </Card>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
