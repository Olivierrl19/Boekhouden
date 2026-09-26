import { useState } from "react";
import { Copy, Plus, Trash2, Wand2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { cents, formatEuro, sum, type Cents } from "@/domain/money";
import { calculateRates, currentFiscalYear, expectedContribution, resultByPot, today, type BudgetLine, type FiscalYear } from "../ledger";
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

  // Expected contribution this year: the member planning × rates, divided over pots like the real charges.
  let expectedByPot = new Map<string, Cents>();
  try {
    expectedByPot = expectedContribution(state, fy);
  } catch {
    // an inconsistent type (fixed parts above the rate) is reported on the Leden page
  }
  const expected = sum([...expectedByPot.values()]);

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
                  for (const [potId, amount] of expectedByPot) {
                    if (amount > 0) store.addBudgetLine({ fiscalYearId: fy.id, potId, kind: "income", description: "Contributie (verwacht)", amount }, actor);
                  }
                }, "Contributie-inkomsten toegevoegd")}><Wand2 /> Voeg verwachte contributie toe ({formatEuro(cents(expected))})</Button>
              )}
            </div>
            <p className="text-muted-foreground">Verwachte contributie = ledenplanning (Contributie → Ledenplanning) × tarief per soort lid, verdeeld over de potjes zoals bij het opleggen.</p>
          </CardContent>
        </Card>
      )}

      <BudgetSection title="Uitgaven" kind="expense" fy={fy} lines={expense} />
      <BudgetSection title="Inkomsten" kind="income" fy={fy} lines={income} />

      <RateCalculator fy={fy} />

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
  const [f, setF] = useState<{ description: string; potId: string; amount: string; sharedBy: SharedBy }>({ description: "", potId: state.pots[0]?.id ?? "", amount: "", sharedBy: "all" });
  const sorted = [...lines].sort((a, b) => (d.potById.get(a.potId)?.name ?? "").localeCompare(d.potById.get(b.potId)?.name ?? ""));
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader><TableRow><TableHead>Omschrijving</TableHead><TableHead>Potje</TableHead>{kind === "expense" && <TableHead>Betaald door</TableHead>}<TableHead className="text-right">Vorig jaar</TableHead><TableHead className="text-right">Begroot</TableHead>{isAdmin && <TableHead className="print:hidden" />}</TableRow></TableHeader>
          <TableBody>
            {sorted.map((l) => <BudgetRow key={l.id} line={l} />)}
            {isAdmin && (
              <TableRow className="print:hidden">
                <TableCell><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={kind === "income" ? "bijv. Donaties oud-leden" : "bijv. Huur kelder"} className="h-8" /></TableCell>
                <TableCell><Select value={f.potId} onChange={(e) => setF({ ...f, potId: e.target.value })} className="h-8">{state.pots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></TableCell>
                {kind === "expense" && <TableCell><SharedBySelect value={f.sharedBy} onChange={(v) => setF({ ...f, sharedBy: v })} /></TableCell>}
                <TableCell />
                <TableCell><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="0,00" className="h-8 text-right" /></TableCell>
                <TableCell><Button size="sm" onClick={() => run(() => { store.addBudgetLine({ fiscalYearId: fy.id, potId: f.potId, kind, description: f.description, amount: parseAmount(f.amount), ...(kind === "expense" ? { sharedBy: f.sharedBy } : {}) }, actor); setF({ ...f, description: "", amount: "" }); })}><Plus /></Button></TableCell>
              </TableRow>
            )}
          </TableBody>
          <TableFooter><TableRow><TableCell colSpan={kind === "expense" ? 3 : 2}>Totaal {title.toLowerCase()}</TableCell><TableCell className="text-right"><Money value={sum(lines.map((l) => l.lastYear ?? cents(0)))} /></TableCell><TableCell className="text-right"><Money value={sum(lines.map((l) => l.amount))} /></TableCell>{isAdmin && <TableCell className="print:hidden" />}</TableRow></TableFooter>
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
  const euro = (c: number | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));
  const [f, setF] = useState({ description: line.description, potId: line.potId, amount: euro(line.amount), lastYear: euro(line.lastYear), sharedBy: (line.sharedBy ?? "all") as SharedBy });
  if (!edit) {
    return (
      <TableRow onDoubleClick={() => isAdmin && setEdit(true)}>
        <TableCell>{line.description}</TableCell>
        <TableCell className="text-muted-foreground">{d.potById.get(line.potId)?.name}</TableCell>
        {line.kind === "expense" && <TableCell className="text-xs text-muted-foreground">{SHARED_LABEL[line.sharedBy ?? "all"]}</TableCell>}
        <TableCell className="text-right text-muted-foreground">{line.lastYear !== null && line.lastYear !== undefined ? <Money value={line.lastYear} /> : "—"}</TableCell>
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
      {line.kind === "expense" && <TableCell><SharedBySelect value={f.sharedBy} onChange={(v) => setF({ ...f, sharedBy: v })} /></TableCell>}
      <TableCell><Input value={f.lastYear} onChange={(e) => setF({ ...f, lastYear: e.target.value })} className="h-8 text-right" placeholder="—" /></TableCell>
      <TableCell><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className="h-8 text-right" /></TableCell>
      <TableCell className="text-right"><Button size="sm" onClick={() => run(() => { store.updateBudgetLine(line.id, { description: f.description, potId: f.potId, amount: parseAmount(f.amount) as Cents, lastYear: f.lastYear.trim() ? parseAmount(f.lastYear) : null, ...(line.kind === "expense" ? { sharedBy: f.sharedBy } : {}) }, actor); setEdit(false); })}>Opslaan</Button></TableCell>
    </TableRow>
  );
}

type SharedBy = NonNullable<BudgetLine["sharedBy"]>;
const SHARED_LABEL: Record<SharedBy, string> = { all: "Alle leden", young: "Jongerejaars + buitenland", none: "Vaste bijdrage (niet verdelen)" };

function SharedBySelect({ value, onChange }: { value: SharedBy; onChange: (v: SharedBy) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as SharedBy)} className="h-8">
      {(Object.keys(SHARED_LABEL) as SharedBy[]).map((k) => <option key={k} value={k}>{SHARED_LABEL[k]}</option>)}
    </Select>
  );
}

/** The "Begroting" sheet's contribution calculation: budget ÷ planned member-months per type. */
function RateCalculator({ fy }: { fy: FiscalYear }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const [buffer, setBuffer] = useState("");
  let calc: ReturnType<typeof calculateRates> | null = null;
  let error = "";
  try {
    calc = calculateRates(state, fy, buffer.trim() ? parseAmount(buffer) : cents(0));
  } catch (e) {
    error = (e as Error).message;
  }
  const typeName = (id: string | null) => state.memberTypes.find((t) => t.id === id)?.name ?? "";
  const changed = calc?.rates.filter((r) => r.rate !== state.memberTypes.find((t) => t.id === r.typeId)?.monthly && (r.general || r.young || r.likeTypeId)) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contributie berekenen uit de begroting</CardTitle>
        <CardDescription>
          Zoals in jullie begrotingsblad: de posten voor alle leden worden verdeeld over alle lid-maanden van soorten die daaraan meebetalen, de jongerejaarsposten over de jongerejaars- en buitenlandmaanden. Daar komen de vaste delen (woonkamer, bier) bij. Lid-maanden komen uit de ledenplanning. Stel per soort lid in waaraan hij meebetaalt (Leden → Soorten leden).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && <p className="text-sm text-red-700">{error}</p>}
        {calc && (
          <>
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg border p-3"><div className="text-muted-foreground">Posten alle leden</div><div className="font-medium"><Money value={calc.general.total} /> ÷ {calc.general.months} lid-maanden = {calc.general.months ? formatEuro(cents(Math.round(calc.general.total / calc.general.months))) : "—"}</div></div>
              <div className="rounded-lg border p-3"><div className="text-muted-foreground">Jongerejaarsposten</div><div className="font-medium"><Money value={calc.young.total} /> ÷ {calc.young.months} lid-maanden = {calc.young.months ? formatEuro(cents(Math.round(calc.young.total / calc.young.months))) : "—"}</div></div>
              <Field label="Extra buffer / sparen (alle leden)"><Input value={buffer} onChange={(e) => setBuffer(e.target.value)} placeholder="0,00" /></Field>
            </div>
            <Table>
              <TableHeader><TableRow><TableHead>Soort lid</TableHead><TableHead className="text-right">Lid-maanden</TableHead><TableHead>Betaalt mee aan</TableHead><TableHead className="text-right">Vaste delen</TableHead><TableHead className="text-right">Berekend</TableHead><TableHead className="text-right">Nu</TableHead></TableRow></TableHeader>
              <TableBody>
                {calc.rates.map((r) => {
                  const t = state.memberTypes.find((x) => x.id === r.typeId)!;
                  const relevant = r.general || r.young || r.likeTypeId;
                  return (
                    <TableRow key={r.typeId} className={relevant ? "" : "text-muted-foreground"}>
                      <TableCell>{t.name}</TableCell>
                      <TableCell className="text-right">{calc!.months.get(r.typeId) ?? 0}</TableCell>
                      <TableCell className="text-xs">{r.likeTypeId ? `tarief van ${typeName(r.likeTypeId)}` : [r.general && "alle leden", r.young && "jongerejaars"].filter(Boolean).join(" + ") || "niets (tarief blijft)"}</TableCell>
                      <TableCell className="text-right"><Money value={r.fixed} /></TableCell>
                      <TableCell className="text-right font-medium">{relevant ? <Money value={r.rate} /> : "—"}</TableCell>
                      <TableCell className="text-right"><Money value={t.monthly} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {isAdmin && (
              <div>
                <Button disabled={!changed.length} onClick={() => {
                  if (!window.confirm(`Nieuwe tarieven overnemen? ${changed.map((r) => `${typeName(r.typeId)}: ${formatEuro(r.rate)}`).join(", ")}. Geldt vanaf de volgende maand die je oplegt.`)) return;
                  run(() => store.setMemberTypeRates(changed.map((r) => ({ typeId: r.typeId, rate: r.rate })), actor), "Tarieven overgenomen");
                }}>Berekende tarieven overnemen</Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export { Field };
