import { useState } from "react";
import { Copy, Plus, Trash2, Wand2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { allocate, cents, formatEuro, sum, type Cents } from "@/domain/money";
import { currentFiscalYear, resultByPot, today, type BudgetLine, type FiscalYear } from "../ledger";
import { Empty, Field, PageHeader, ReadOnlyNotice, Select, parseAmount, useAction, useApp, useCan, useLedger } from "./core";

export function BudgetPage() {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const years = [...state.fiscalYears].sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  const [fyId, setFyId] = useState<string | null>(null);
  const fy: FiscalYear | null = years.find((y) => y.id === fyId) ?? currentFiscalYear(state, today());
  const [newPot, setNewPot] = useState("");
  if (!fy) return <Empty>Geen boekjaar.</Empty>;
  const prev = years.find((y) => y.endDate < fy.startDate);
  const lines = state.budgets.filter((b) => b.fiscalYearId === fy.id);
  const income = lines.filter((b) => b.kind === "income");
  const expense = lines.filter((b) => b.kind === "expense");
  const totalIncome = sum(income.map((b) => b.amount));
  const totalExpense = sum(expense.map((b) => b.amount));
  const actual = resultByPot(state, fy);

  // Expected contribution this year: active paying members × monthly × 12, split with the key.
  const expected = state.parties.filter((p) => p.active && p.member).reduce((s, p) => s + (state.memberTypes.find((t) => t.id === p.member!.memberTypeId)?.monthly ?? 0) * 12, 0);
  const key = state.settings.contributionKey;
  const expectedSplit = key.length ? allocate(cents(expected), key.map((k) => k.weight)) : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Begroting" description="Per boekjaar: alle verwachte inkomsten en uitgaven, per potje. Reserveren (bijv. voor het lustrum) is een uitgave in potje Reserveringen.">
        <Select value={fy.id} onChange={(e) => setFyId(e.target.value)} className="w-44">
          {years.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}
        </Select>
        <Button variant="outline" onClick={() => window.print()}><Printer /> Afdrukken voor de ALV</Button>
      </PageHeader>
      <ReadOnlyNotice />

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardHeader><CardDescription>Begrote inkomsten</CardDescription><CardTitle className="text-xl"><Money value={totalIncome} /></CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Begrote uitgaven</CardDescription><CardTitle className="text-xl"><Money value={totalExpense} /></CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Begroot resultaat</CardDescription><CardTitle className={`text-xl ${totalIncome - totalExpense < 0 ? "text-red-700" : "text-emerald-700"}`}><Money value={totalIncome - totalExpense} /></CardTitle></CardHeader></Card>
      </div>

      {isAdmin && (
        <Card className="print:hidden">
          <CardHeader><CardTitle>Snel beginnen</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap gap-2">
              {prev && <Button variant="outline" onClick={() => run(() => { const n = store.copyBudget(prev.id, fy.id, "budget", actor); if (!n) throw new Error(`Er is geen begroting ${prev.label} om te kopiëren`); }, "Begroting vorig jaar gekopieerd")}><Copy /> Kopieer begroting {prev.label}</Button>}
              {prev && <Button variant="outline" onClick={() => run(() => { const n = store.copyBudget(prev.id, fy.id, "actual", actor); if (!n) throw new Error(`Er is geen realisatie ${prev.label}`); }, "Realisatie vorig jaar als begroting overgenomen")}><Copy /> Neem realisatie {prev.label} over</Button>}
              {expected > 0 && (
                <Button variant="outline" onClick={() => run(() => {
                  key.forEach((k, i) => {
                    if (expectedSplit[i] > 0) store.addBudgetLine({ fiscalYearId: fy.id, potId: k.potId, kind: "income", description: `Contributie (${Math.round((k.weight / key.reduce((s, x) => s + x.weight, 0)) * 100)}%)`, amount: expectedSplit[i] }, actor);
                  });
                }, "Contributie-inkomsten toegevoegd")}><Wand2 /> Voeg verwachte contributie toe ({formatEuro(cents(expected))})</Button>
              )}
            </div>
            <p className="text-muted-foreground">Verwachte contributie = huidige leden × tarief × 12 maanden, verdeeld volgens de verdeelsleutel bij Contributie.</p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-2">
        <BudgetSection title="Inkomsten" kind="income" fy={fy} lines={income} />
        <BudgetSection title="Uitgaven" kind="expense" fy={fy} lines={expense} />
      </div>

      <Card>
        <CardHeader><CardTitle>Per potje: begroting en realisatie</CardTitle><CardDescription>Realisatie tot nu toe in {fy.label}.</CardDescription></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Potje</TableHead><TableHead className="text-right">Begroot saldo</TableHead><TableHead className="text-right">Werkelijk saldo</TableHead><TableHead className="text-right">Verschil</TableHead></TableRow></TableHeader>
            <TableBody>
              {state.pots.map((p) => {
                const b = sum(income.filter((l) => l.potId === p.id).map((l) => l.amount)) - sum(expense.filter((l) => l.potId === p.id).map((l) => l.amount));
                const r = actual.get(p.id);
                const a = r ? r.income - r.expense : 0;
                if (!b && !a) return null;
                return (
                  <TableRow key={p.id}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell className="text-right"><Money value={b} /></TableCell>
                    <TableCell className="text-right"><Money value={a} /></TableCell>
                    <TableCell className={`text-right ${a - b < 0 ? "text-red-700" : "text-emerald-700"}`}><Money value={a - b} /></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isAdmin && (
        <Card className="print:hidden">
          <CardHeader><CardTitle>Nieuw potje</CardTitle><CardDescription>Bijv. “Gala”, “Merchandise” of “Huisfonds”. Daarna kun je er begroting, kosten en inkomsten aan koppelen.</CardDescription></CardHeader>
          <CardContent className="flex gap-2">
            <Input value={newPot} onChange={(e) => setNewPot(e.target.value)} placeholder="Naam van het potje" className="max-w-sm" />
            <Button onClick={() => run(() => { store.createPot({ name: newPot, kind: "both" }, actor); setNewPot(""); }, "Potje aangemaakt")}><Plus /> Toevoegen</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function BudgetSection({ title, kind, fy, lines }: { title: string; kind: "income" | "expense"; fy: FiscalYear; lines: BudgetLine[] }) {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const [f, setF] = useState({ description: "", potId: state.pots[0]?.id ?? "", amount: "" });
  const sorted = [...lines].sort((a, b) => (d.potById.get(a.potId)?.name ?? "").localeCompare(d.potById.get(b.potId)?.name ?? ""));
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Omschrijving</TableHead><TableHead>Potje</TableHead><TableHead className="text-right">Bedrag per jaar</TableHead>{isAdmin && <TableHead className="print:hidden" />}</TableRow></TableHeader>
          <TableBody>
            {sorted.map((l) => <BudgetRow key={l.id} line={l} />)}
            {isAdmin && (
              <TableRow className="print:hidden">
                <TableCell><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={kind === "income" ? "bijv. Donaties oud-leden" : "bijv. Huur kelder"} className="h-8" /></TableCell>
                <TableCell><Select value={f.potId} onChange={(e) => setF({ ...f, potId: e.target.value })} className="h-8">{state.pots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></TableCell>
                <TableCell><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0,00" className="h-8 text-right" /></TableCell>
                <TableCell><Button size="sm" onClick={() => run(() => { store.addBudgetLine({ fiscalYearId: fy.id, potId: f.potId, kind, description: f.description, amount: parseAmount(f.amount) }, actor); setF({ ...f, description: "", amount: "" }); })}><Plus /></Button></TableCell>
              </TableRow>
            )}
          </TableBody>
          <TableFooter><TableRow><TableCell colSpan={2}>Totaal {title.toLowerCase()}</TableCell><TableCell className="text-right"><Money value={sum(lines.map((l) => l.amount))} /></TableCell>{isAdmin && <TableCell className="print:hidden" />}</TableRow></TableFooter>
        </Table>
      </CardContent>
    </Card>
  );
}

function BudgetRow({ line }: { line: BudgetLine }) {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ description: line.description, potId: line.potId, amount: (line.amount / 100).toFixed(2).replace(".", ",") });
  if (!edit) {
    return (
      <TableRow onDoubleClick={() => isAdmin && setEdit(true)}>
        <TableCell>{line.description}</TableCell>
        <TableCell className="text-muted-foreground">{d.potById.get(line.potId)?.name}</TableCell>
        <TableCell className="text-right"><Money value={line.amount} /></TableCell>
        {isAdmin && (
          <TableCell className="whitespace-nowrap text-right print:hidden">
            <Button variant="ghost" size="sm" onClick={() => setEdit(true)}>Wijzig</Button>
            <Button variant="ghost" size="icon" aria-label="Verwijder" onClick={() => run(() => store.removeBudgetLine(line.id, actor))}><Trash2 /></Button>
          </TableCell>
        )}
      </TableRow>
    );
  }
  return (
    <TableRow>
      <TableCell><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} className="h-8" /></TableCell>
      <TableCell><Select value={f.potId} onChange={(e) => setF({ ...f, potId: e.target.value })} className="h-8">{state.pots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></TableCell>
      <TableCell><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="h-8 text-right" /></TableCell>
      <TableCell className="text-right"><Button size="sm" onClick={() => run(() => { store.updateBudgetLine(line.id, { description: f.description, potId: f.potId, amount: parseAmount(f.amount) as Cents }, actor); setEdit(false); })}>Opslaan</Button></TableCell>
    </TableRow>
  );
}

export { Field };
