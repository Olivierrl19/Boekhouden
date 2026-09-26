import { useRef, useState } from "react";
import { Download, Lock, Printer, RotateCcw, ShieldCheck, Upload, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { cents, formatEuro, sum, type Cents } from "@/domain/money";
import { formatDateNl } from "@/domain/dates";
import { accountBalances, currentFiscalYear, resultByPot, today, type FiscalYear, type State } from "../ledger";
import { Empty, Field, PageHeader, ReadOnlyNotice, Select, csvLine, download, parseAmount, useAction, useApp, useCan, useLedger } from "./core";
import { TEMPLATE_LABEL, lineTarget } from "./labels";

function useYear(): [FiscalYear | null, (id: string) => void, FiscalYear[]] {
  const { state } = useLedger();
  const [id, setId] = useState<string | null>(null);
  const years = [...state.fiscalYears].sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  const fy = years.find((y) => y.id === id) ?? currentFiscalYear(state, today());
  return [fy, setId, years];
}

function YearPicker({ fy, setId, years }: { fy: FiscalYear; setId: (id: string) => void; years: FiscalYear[] }) {
  return (
    <Select value={fy.id} onChange={(e) => setId(e.target.value)} className="w-44">
      {years.map((y) => <option key={y.id} value={y.id}>{y.label}{y.status === "closed" ? " (afgesloten)" : ""}</option>)}
    </Select>
  );
}

// ---------------------------------------------------------------------------
// Reports: balance sheet and result per pot vs budget
// ---------------------------------------------------------------------------

function balanceSheet(state: State, fy: FiscalYear) {
  const balances = accountBalances(state, fy);
  const byKey = new Map(state.accounts.filter((a) => a.systemKey).map((a) => [a.systemKey!, a.id]));
  // Person accounts: positive balances are receivables, negative balances are debts ("tegoeden").
  const personAccounts = new Set([byKey.get("MEMBER_ACCOUNTS"), byKey.get("EXTERNAL_ACCOUNTS"), byKey.get("ACCOUNTS_PAYABLE")]);
  const perParty = new Map<string, number>();
  for (const e of state.entries) if (e.date <= fy.endDate) for (const l of e.lines) if (l.partyId) perParty.set(l.partyId, (perParty.get(l.partyId) ?? 0) + l.amount);
  const receivable = [...perParty.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const credit = -[...perParty.values()].filter((v) => v < 0).reduce((a, b) => a + b, 0);
  const assets: { label: string; amount: number }[] = [];
  const liabilities: { label: string; amount: number }[] = [];
  const equity: { label: string; amount: number }[] = [];
  for (const acc of state.accounts) {
    if (personAccounts.has(acc.id) || acc.type === "income" || acc.type === "expense") continue;
    const b = balances.get(acc.id) ?? 0;
    if (b === 0 && !acc.systemKey?.startsWith("GENERAL")) continue;
    const label = acc.systemKey === "BANK_SUSPENSE" ? "Bankregels nog toe te wijzen" : acc.name;
    if (acc.type === "asset") assets.push({ label, amount: b });
    else if (acc.type === "liability") liabilities.push({ label: acc.name, amount: -b });
    else equity.push({ label: acc.name, amount: -b });
  }
  assets.push({ label: "Te ontvangen van personen", amount: receivable });
  liabilities.push({ label: "Tegoeden van personen", amount: credit });
  const result = -[...balances].filter(([id]) => { const a = state.accounts.find((x) => x.id === id)!; return a.type === "income" || a.type === "expense"; }).reduce((s, [, v]) => s + v, 0);
  if (result !== 0) equity.push({ label: "Resultaat lopend boekjaar", amount: result });
  return { assets, liabilities, equity };
}

export function ReportsPage() {
  const { state } = useLedger();
  const isAdmin = useCan("admin");
  const [fy, setId, years] = useYear();
  if (!fy) return <Empty>Geen boekjaar.</Empty>;
  const prev = years.find((y) => y.endDate < fy.startDate);
  const bs = balanceSheet(state, fy);
  const totalAssets = sum(bs.assets.map((a) => cents(a.amount)));
  const totalPassive = sum([...bs.liabilities, ...bs.equity].map((a) => cents(a.amount)));
  const res = resultByPot(state, fy);
  const resPrev = prev ? resultByPot(state, prev) : new Map();
  const budget = (potId: string, kind: "income" | "expense") => state.budgets.find((b) => b.fiscalYearId === fy.id && b.potId === potId && b.kind === kind)?.amount ?? cents(0);
  const rows = state.pots.map((p) => {
    const r = res.get(p.id) ?? { income: 0, expense: 0 };
    const rp = resPrev.get(p.id) ?? { income: 0, expense: 0 };
    return { pot: p, income: r.income, expense: r.expense, net: r.income - r.expense, prevNet: rp.income - rp.expense, budgetNet: budget(p.id, "income") - budget(p.id, "expense") };
  }).filter((r) => r.income || r.expense || r.budgetNet || r.prevNet);

  const exportCsv = () => {
    const lines = [csvLine(["Potje", "Baten", "Lasten", "Saldo", "Begroting", "Verschil", "Vorig jaar"]), ...rows.map((r) => csvLine([r.pot.name, ...[r.income, r.expense, r.net, r.budgetNet, r.net - r.budgetNet, r.prevNet].map((v) => (v / 100).toFixed(2).replace(".", ","))]))];
    download(`resultaat-${fy.label}.csv`, "﻿" + lines.join("\r\n"));
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Rapportages" description="Balans en resultatenrekening per potje, met begroting en vorig jaar. Afdrukken geeft een PDF voor de ALV.">
        <YearPicker fy={fy} setId={setId} years={years} />
        <Button variant="outline" onClick={exportCsv}><Download /> Excel/CSV</Button>
        <Button variant="outline" onClick={() => window.print()}><Printer /> Afdrukken / PDF</Button>
      </PageHeader>
      <div className="hidden print:block"><h2 className="text-xl font-semibold">{state.settings.name} — jaarrekening {fy.label}</h2></div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Activa</CardTitle><CardDescription>per {formatDateNl(fy.endDate < today() ? fy.endDate : today())}</CardDescription></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>{bs.assets.map((a) => <TableRow key={a.label}><TableCell>{a.label}</TableCell><TableCell className="text-right"><Money value={a.amount} /></TableCell></TableRow>)}</TableBody>
              <TableFooter><TableRow><TableCell>Totaal</TableCell><TableCell className="text-right"><Money value={totalAssets} /></TableCell></TableRow></TableFooter>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Passiva</CardTitle><CardDescription>{totalAssets === totalPassive ? "Activa = passiva ✓" : "Let op: verschil!"}</CardDescription></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableBody>
                {bs.equity.map((a) => <TableRow key={a.label}><TableCell>{a.label}</TableCell><TableCell className="text-right"><Money value={a.amount} /></TableCell></TableRow>)}
                {bs.liabilities.map((a) => <TableRow key={a.label}><TableCell>{a.label}</TableCell><TableCell className="text-right"><Money value={a.amount} /></TableCell></TableRow>)}
              </TableBody>
              <TableFooter><TableRow><TableCell>Totaal</TableCell><TableCell className="text-right"><Money value={totalPassive} /></TableCell></TableRow></TableFooter>
            </Table>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>Resultaat per potje</CardTitle><CardDescription>Saldo = baten − lasten (positief is over). Het dispuutsdeel van activiteiten en borrels telt hier mee; wat over leden is verdeeld niet.</CardDescription></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Potje</TableHead><TableHead className="text-right">Baten</TableHead><TableHead className="text-right">Lasten</TableHead><TableHead className="text-right">Saldo</TableHead><TableHead className="text-right">Begroting</TableHead><TableHead className="text-right">Verschil</TableHead>{prev && <TableHead className="text-right">{prev.label}</TableHead>}</TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.pot.id}>
                  <TableCell>{r.pot.name}</TableCell>
                  <TableCell className="text-right"><Money value={r.income} /></TableCell>
                  <TableCell className="text-right"><Money value={r.expense} /></TableCell>
                  <TableCell className="text-right font-medium"><Money value={r.net} /></TableCell>
                  <TableCell className="text-right text-muted-foreground"><Money value={r.budgetNet} /></TableCell>
                  <TableCell className={`text-right ${r.net - r.budgetNet < 0 ? "text-red-700" : "text-emerald-700"}`}><Money value={r.net - r.budgetNet} /></TableCell>
                  {prev && <TableCell className="text-right text-muted-foreground"><Money value={r.prevNet} /></TableCell>}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Totaal</TableCell>
                <TableCell className="text-right"><Money value={rows.reduce((s, r) => s + r.income, 0)} /></TableCell>
                <TableCell className="text-right"><Money value={rows.reduce((s, r) => s + r.expense, 0)} /></TableCell>
                <TableCell className="text-right"><Money value={rows.reduce((s, r) => s + r.net, 0)} /></TableCell>
                <TableCell className="text-right"><Money value={rows.reduce((s, r) => s + r.budgetNet, 0)} /></TableCell>
                <TableCell className="text-right"><Money value={rows.reduce((s, r) => s + r.net - r.budgetNet, 0)} /></TableCell>
                {prev && <TableCell className="text-right"><Money value={rows.reduce((s, r) => s + r.prevNet, 0)} /></TableCell>}
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>
      {isAdmin && <BudgetEditor fy={fy} />}
    </div>
  );
}

function BudgetEditor({ fy }: { fy: FiscalYear }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const run = useAction();
  const [potId, setPotId] = useState(state.pots[0]?.id ?? "");
  const [kind, setKind] = useState<"income" | "expense">("expense");
  const [amount, setAmount] = useState("");
  return (
    <Card className="print:hidden">
      <CardHeader><CardTitle>Begroting {fy.label} aanpassen</CardTitle><CardDescription>Reserveren (bijv. voor het lustrum) doe je via potje Reserveringen; boek de dotatie bij Boekjaar.</CardDescription></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <Field label="Potje"><Select value={potId} onChange={(e) => setPotId(e.target.value)}>{state.pots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label="Soort"><Select value={kind} onChange={(e) => setKind(e.target.value as "income" | "expense")}><option value="expense">Lasten</option><option value="income">Baten</option></Select></Field>
        <Field label="Bedrag per jaar"><Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="500,00" /></Field>
        <Button onClick={() => run(() => { store.setBudget({ fiscalYearId: fy.id, potId, kind, amount: parseAmount(amount) }, actor); setAmount(""); }, "Begroting opgeslagen")}>Opslaan</Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Journal (debit/credit visible here only)
// ---------------------------------------------------------------------------

export function JournalPage() {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const [fy, setId, years] = useYear();
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  if (!fy) return <Empty>Geen boekjaar.</Empty>;
  const all = state.entries.filter((e) => e.fiscalYearId === fy.id && (!q || `${e.entryNumber} ${e.description}`.toLowerCase().includes(q.toLowerCase()))).slice().reverse();
  const PAGE = 40;
  const entries = all.slice(page * PAGE, page * PAGE + PAGE);
  const exportCsv = () => {
    const lines = [csvLine(["Nummer", "Datum", "Soort", "Omschrijving", "Rekening", "Potje/persoon/activiteit", "Debet", "Credit", "Reden"])];
    for (const e of state.entries.filter((x) => x.fiscalYearId === fy.id)) for (const l of e.lines) {
      const acc = d.accountById.get(l.accountId)!;
      lines.push(csvLine([e.entryNumber, e.date, TEMPLATE_LABEL[e.template] ?? e.template, e.description, `${acc.code} ${acc.name}`, lineTarget(state, d, l), l.amount > 0 ? (l.amount / 100).toFixed(2).replace(".", ",") : "", l.amount < 0 ? (-l.amount / 100).toFixed(2).replace(".", ",") : "", e.reason ?? ""]));
    }
    download(`journaal-${fy.label}.csv`, "﻿" + lines.join("\r\n"));
  };
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Journaal" description={`${all.length} journaalposten. Hier zie je de boekhouding zoals een accountant hem ziet: debet en credit.`}>
        <YearPicker fy={fy} setId={(id) => { setId(id); setPage(0); }} years={years} />
        <Input placeholder="Zoeken…" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} className="w-44" />
        <Button variant="outline" onClick={exportCsv}><Download /> Excel/CSV</Button>
      </PageHeader>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Nummer / datum</TableHead><TableHead>Omschrijving</TableHead><TableHead>Rekening</TableHead><TableHead className="text-right">Debet</TableHead><TableHead className="text-right">Credit</TableHead></TableRow></TableHeader>
            <TableBody>
              {entries.map((e) => e.lines.map((l, i) => {
                const acc = d.accountById.get(l.accountId)!;
                return (
                  <TableRow key={`${e.id}-${i}`} className={i === 0 ? "border-t-2" : "border-0"}>
                    <TableCell className="align-top whitespace-nowrap">{i === 0 && <><div className="font-mono text-xs">{e.entryNumber}</div><div className="text-xs text-muted-foreground">{formatDateNl(e.date)}</div></>}</TableCell>
                    <TableCell className="align-top">
                      {i === 0 && (
                        <>
                          <div>{e.description}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Badge variant="outline">{TEMPLATE_LABEL[e.template] ?? e.template}</Badge>
                            {e.isAutomatic && <Badge variant="secondary">automatisch</Badge>}
                            {e.reversesEntryId && <Badge variant="warning">tegenboeking van {d.entryById.get(e.reversesEntryId)?.entryNumber}</Badge>}
                            {d.reversedIds.has(e.id) && <Badge variant="destructive">tegengeboekt</Badge>}
                          </div>
                          {e.reason && <div className="mt-1 text-xs text-muted-foreground">Reden: {e.reason}</div>}
                          <div className="text-xs text-muted-foreground">door {e.createdBy}</div>
                          {isAdmin && ["T29", "T21"].includes(e.template) && !d.reversedIds.has(e.id) && (
                            <Button variant="ghost" size="sm" className="-ml-3" onClick={() => { const r = window.prompt("Reden van de tegenboeking?"); if (r) run(() => store.reverseEntry(e.id, r, actor), "Tegengeboekt"); }}><RotateCcw /> Tegenboeken</Button>
                          )}
                        </>
                      )}
                    </TableCell>
                    <TableCell><span className="font-mono text-xs">{acc.code}</span> {acc.name}<div className="text-xs text-muted-foreground">{l.partyId || l.activityId || l.potId ? lineTarget(state, d, l) : ""}</div></TableCell>
                    <TableCell className="text-right">{l.amount > 0 && <Money value={l.amount} />}</TableCell>
                    <TableCell className="text-right">{l.amount < 0 && <Money value={-l.amount} />}</TableCell>
                  </TableRow>
                );
              }))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between text-sm">
        <span>Pagina {page + 1} van {Math.max(1, Math.ceil(all.length / PAGE))}</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Nieuwer</Button>
          <Button variant="outline" size="sm" disabled={(page + 1) * PAGE >= all.length} onClick={() => setPage(page + 1)}>Ouder</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fiscal year: reserves, closing, reopening, memorial
// ---------------------------------------------------------------------------

export function YearPage() {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const [fy, setId, years] = useYear();
  const reserves = state.accounts.filter((a) => a.type === "equity" && !a.systemKey);
  const general = state.accounts.find((a) => a.systemKey === "GENERAL_RESERVE")!;
  const [dotation, setDotation] = useState({ accountId: reserves[0]?.id ?? "", amount: "", description: "Dotatie lustrumfonds (begroting)" });
  const [split, setSplit] = useState<Record<string, string>>({});
  const [memo, setMemo] = useState({ debit: "", credit: "", amount: "", description: "", reason: "", potId: "" });
  if (!fy) return <Empty>Geen boekjaar.</Empty>;
  const checklist = store.closingChecklist(fy.id);
  const pnl = [...resultByPot(state, fy).values()].reduce((s, r) => s + r.income - r.expense, 0);
  const balances = accountBalances(state, fy);
  const reserveTotal = sum(Object.values(split).map((v) => { try { return v.trim() ? parseAmount(v) : cents(0); } catch { return cents(0); } }));
  const toGeneral = pnl - reserveTotal;
  const manualAccounts = state.accounts.filter((a) => a.manualPostingAllowed && !a.partyKind && !a.requiresActivity);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Boekjaar" description="Reserveren, jaar afsluiten (met controlelijst) en correcties.">
        <YearPicker fy={fy} setId={setId} years={years} />
      </PageHeader>
      <ReadOnlyNotice />
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2">{fy.status === "closed" ? <Lock className="size-5" /> : null} {fy.label}: {fy.status === "closed" ? "afgesloten" : "open"}</CardTitle><CardDescription>{formatDateNl(fy.startDate)} t/m {formatDateNl(fy.endDate)} · resultaat {formatEuro(cents(fy.status === "closed" ? pnl : pnl))}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            {checklist.map((c) => (
              <div key={c.key} className="flex items-center gap-2 text-sm">
                {c.ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-red-600" />}
                {c.label}{c.detail && <span className="text-muted-foreground">({c.detail})</span>}
              </div>
            ))}
          </div>
          {fy.status !== "closed" && isAdmin && (
            <div className="flex flex-col gap-3 rounded-md border p-4">
              <div className="text-sm font-medium">Resultaatbestemming: {formatEuro(cents(pnl))} {pnl >= 0 ? "over" : "tekort"}</div>
              {reserves.map((r) => (
                <Field key={r.id} label={`Naar ${r.name}`}><Input value={split[r.id] ?? ""} onChange={(e) => setSplit({ ...split, [r.id]: e.target.value })} placeholder="0,00" className="w-40" /></Field>
              ))}
              <div className="text-sm">Rest naar {general.name}: <strong>{formatEuro(cents(toGeneral))}</strong></div>
              <Button className="self-start" disabled={checklist.some((c) => !c.ok)} onClick={() => {
                if (!window.confirm(`Boekjaar ${fy.label} afsluiten? Daarna kan er niets meer in geboekt worden (heropenen kan, met reden).`)) return;
                run(() => {
                  const appropriation = [...reserves.map((r) => ({ accountId: r.id, amount: split[r.id]?.trim() ? parseAmount(split[r.id]) : cents(0) })), { accountId: general.id, amount: cents(toGeneral) }].filter((a) => a.amount !== 0);
                  store.closeFiscalYear(fy.id, appropriation, actor);
                }, "Boekjaar afgesloten");
              }}><Lock /> Boekjaar afsluiten</Button>
            </div>
          )}
          {fy.status === "closed" && isAdmin && (
            <Button variant="outline" className="self-start" onClick={() => { const r = window.prompt("Waarom heropen je dit boekjaar? (bijv. correctie kascommissie)"); if (r) run(() => store.reopenFiscalYear(fy.id, r, actor), "Boekjaar heropend"); }}><RotateCcw /> Heropenen</Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Bestemmingsreserves</CardTitle><CardDescription>Stand per einde boekjaar.</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Table><TableBody>{[general, ...reserves].map((r) => <TableRow key={r.id}><TableCell>{r.name}</TableCell><TableCell className="text-right"><Money value={-(balances.get(r.id) ?? 0)} /></TableCell></TableRow>)}</TableBody></Table>
          {isAdmin && fy.status === "open" && (
            <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
              <Field label="Reserve"><Select value={dotation.accountId} onChange={(e) => setDotation({ ...dotation, accountId: e.target.value })}>{reserves.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
              <Field label="Bedrag"><Input value={dotation.amount} onChange={(e) => setDotation({ ...dotation, amount: e.target.value })} placeholder="500,00" /></Field>
              <Field label="Omschrijving"><Input value={dotation.description} onChange={(e) => setDotation({ ...dotation, description: e.target.value })} /></Field>
              <Button variant="outline" onClick={() => run(() => store.dotateReserve({ date: today() > fy.endDate ? fy.endDate : today(), reserveAccountId: dotation.accountId, amount: parseAmount(dotation.amount), description: dotation.description }, actor), "Dotatie geboekt (kosten in potje Reserveringen)")}>Reserveren</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {isAdmin && fy.status === "open" && (
        <Card>
          <CardHeader><CardTitle>Memoriaal (handmatige boeking)</CardTitle><CardDescription>Voor correcties en overlopende posten. Alleen de fiscus, altijd met reden. Bank, kas en persoonsrekeningen kunnen hier niet.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <Field label="Debet"><Select value={memo.debit} onChange={(e) => setMemo({ ...memo, debit: e.target.value })}><option value="">Kies…</option>{manualAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select></Field>
            <Field label="Credit"><Select value={memo.credit} onChange={(e) => setMemo({ ...memo, credit: e.target.value })}><option value="">Kies…</option>{manualAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</Select></Field>
            <Field label="Potje (bij baten/lasten)"><Select value={memo.potId} onChange={(e) => setMemo({ ...memo, potId: e.target.value })}><option value="">—</option>{state.pots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Bedrag"><Input value={memo.amount} onChange={(e) => setMemo({ ...memo, amount: e.target.value })} /></Field>
            <Field label="Omschrijving"><Input value={memo.description} onChange={(e) => setMemo({ ...memo, description: e.target.value })} /></Field>
            <Field label="Reden (verplicht)"><Input value={memo.reason} onChange={(e) => setMemo({ ...memo, reason: e.target.value })} /></Field>
            <Button className="self-start" onClick={() => run(() => {
              const amount = parseAmount(memo.amount);
              const potFor = (id: string) => { const a = d.accountById.get(id); return a && (a.type === "income" || a.type === "expense") ? memo.potId || null : null; };
              store.postMemorial({ date: today() > fy.endDate ? fy.endDate : today(), description: memo.description, reason: memo.reason, lines: [{ accountId: memo.debit, amount, potId: potFor(memo.debit) }, { accountId: memo.credit, amount: cents(-amount), potId: potFor(memo.credit) }] }, actor);
              setMemo({ debit: "", credit: "", amount: "", description: "", reason: "", potId: "" });
            }, "Memoriaalpost geboekt")}>Boeken</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Integrity checks and audit log
// ---------------------------------------------------------------------------

export function ControlPage() {
  const { store } = useApp();
  const { state } = useLedger();
  const checks = store.verify();
  const [n, setN] = useState(50);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Controle" description="Voor de kascommissie: klopt alles, en is er niets achteraf veranderd?" />
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" /> Zelfcontrole</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2">
          {checks.map((c) => (
            <div key={c.label} className="flex items-center gap-2 text-sm">
              {c.ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <XCircle className="size-4 text-red-600" />}
              {c.label} <span className="text-muted-foreground">{c.detail}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Logboek</CardTitle><CardDescription>Elke actie, met wie en wanneer. Elke regel bevat een vingerafdruk (hash) van de vorige: achteraf wijzigen valt direct op.</CardDescription></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>#</TableHead><TableHead>Wanneer</TableHead><TableHead>Wie</TableHead><TableHead>Actie</TableHead><TableHead>Hash</TableHead></TableRow></TableHeader>
            <TableBody>
              {state.audit.slice(-n).reverse().map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.id}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{new Date(r.at).toLocaleString("nl-NL")}</TableCell>
                  <TableCell className="text-xs">{r.actor}</TableCell>
                  <TableCell className="text-xs">{r.action}{r.reason && <span className="text-muted-foreground"> — {r.reason}</span>}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.hash.slice(0, 12)}…</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {state.audit.length > n && <div className="p-3"><Button variant="outline" size="sm" onClick={() => setN(n + 200)}>Meer tonen</Button></div>}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings: backup, restore, reset
// ---------------------------------------------------------------------------

export function SettingsPage({ onReset }: { onReset: () => void }) {
  const { store, notify } = useApp();
  const { state } = useLedger();
  const isAdmin = useCan("admin");
  const fileRef = useRef<HTMLInputElement>(null);
  const size = new Blob([JSON.stringify(state)]).size;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Instellingen en back-up" description="Alles staat in deze browser op deze computer. Maak regelmatig een back-up, en gebruik die om de gegevens op een andere computer te openen." />
      <Card>
        <CardHeader><CardTitle>Back-up</CardTitle><CardDescription>Gebruikt {(size / 1024).toFixed(0)} kB van de ongeveer 5.000 kB die de browser toestaat.</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={() => download(`boekhouding-${state.settings.name.replace(/\W+/g, "-").toLowerCase()}-${today()}.json`, JSON.stringify(state), "application/json")}><Download /> Back-up downloaden</Button>
          {isAdmin && (
            <>
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                try {
                  const next = JSON.parse(await file.text());
                  if (next?.version !== 1 || !Array.isArray(next.entries)) throw new Error("Dit is geen back-up van deze boekhouding");
                  if (!window.confirm("De huidige gegevens in deze browser worden vervangen door de back-up. Doorgaan?")) return;
                  store.replaceState(next);
                  const bad = store.verify().filter((c) => !c.ok);
                  notify(bad.length ? `Back-up geladen, maar controle faalt: ${bad.map((b) => b.label).join("; ")}` : "Back-up geladen en gecontroleerd", bad.length ? "error" : "ok");
                } catch (err) {
                  notify((err as Error).message, "error");
                }
              }} />
              <Button variant="outline" onClick={() => fileRef.current?.click()}><Upload /> Back-up terugzetten</Button>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Opnieuw beginnen</CardTitle><CardDescription>Wist alles in deze browser en toont het beginscherm (voorbeelddispuut of een eigen dispuut). Maak eerst een back-up als je de gegevens wilt bewaren.</CardDescription></CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={() => { if (window.confirm(state.settings.isDemo ? "Voorbeelddispuut wissen?" : "ALLE gegevens van dit dispuut in deze browser wissen? Dit kan niet ongedaan worden gemaakt (tenzij je een back-up hebt).")) onReset(); }}>Alles wissen en opnieuw beginnen</Button>
        </CardContent>
      </Card>
    </div>
  );
}

export type { Cents };
