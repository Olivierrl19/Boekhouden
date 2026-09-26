import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Mail, Copy, Download, Printer, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { cents, formatEuro, sum, type Cents } from "@/domain/money";
import { addMonths, firstOfMonth, formatDateNl, formatMonthNl, localDate, type LocalDate } from "@/domain/dates";
import { formatIban } from "@/domain/bank/iban";
import { currentFiscalYear, resultByPot, today, type MemberType, type Party, type State } from "../ledger";
export type { Ledger as StatementLedger };
import { A, Empty, Field, PageHeader, ReadOnlyNotice, Select, csvLine, download, go, parseAmount, useAction, useApp, useCan, useLedger } from "./core";
import { lineTarget } from "./labels";
import { parseHundredths } from "@/domain/joint-activity";

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function DashboardPage() {
  const { state, d } = useLedger();
  const fy = currentFiscalYear(state, today());
  const persons = state.parties.map((p) => owedBy(d, p.id).total as number);
  const contributionOpen = sum(state.parties.map((p) => cents(Math.max(0, d.contributionBalance.get(p.id) ?? 0))));
  const savingsTotal = sum([...d.savingsByParty.values()]);
  const openActs = state.activities.filter((a) => a.status === "open");
  const pnl = fy ? [...resultByPot(state, fy).values()].reduce((s, r) => s + r.income - r.expense, 0) : 0;
  const pendingClaims = state.claims.filter((c) => c.status === "submitted").length;
  const thisMonth = firstOfMonth(today());
  const contributionDone = state.contributionMonths.some((c) => c.month === thisMonth);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overzicht" description={fy ? `Boekjaar ${fy.label}` : undefined} />
      <A to="bank">
        {d.unassigned.length === 0 ? (
          <Card className="border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40">
            <CardContent className="flex items-center gap-3 p-5"><CheckCircle2 className="size-6 text-emerald-600" /><div><div className="font-semibold">De boekhouding is bij</div><div className="text-sm text-muted-foreground">Alle banktransacties zijn toegewezen.</div></div></CardContent>
          </Card>
        ) : (
          <Card className="border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
            <CardContent className="flex items-center gap-3 p-5"><AlertTriangle className="size-6 text-amber-600" /><div><div className="font-semibold">{d.unassigned.length} {d.unassigned.length === 1 ? "transactie" : "transacties"} nog toe te wijzen</div><div className="text-sm text-muted-foreground">Geef elke bankregel een plek. Nul betekent: de boekhouding is bij.</div></div></CardContent>
          </Card>
        )}
      </A>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {state.bankAccounts.map((b) => {
          const last = state.bankTransactions.filter((t) => t.bankAccountId === b.id).at(-1);
          return (
            <Card key={b.id}>
              <CardHeader>
                <CardDescription>{b.name}</CardDescription>
                <CardTitle className="text-2xl"><Money value={d.bankBalance.get(b.id) ?? 0} /></CardTitle>
                <CardDescription className="text-xs">{b.iban ? formatIban(b.iban) : "Contant"}{last && ` · t/m ${formatDateNl(last.bookingDate)}`}</CardDescription>
              </CardHeader>
            </Card>
          );
        })}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <A to="debiteuren"><Card><CardHeader><CardDescription>Nog te ontvangen van personen</CardDescription><CardTitle className="text-xl"><Money value={sum(persons.filter((b) => b > 0) as Cents[])} /></CardTitle></CardHeader></Card></A>
        <A to="debiteuren"><Card><CardHeader><CardDescription>Tegoeden van personen</CardDescription><CardTitle className="text-xl"><Money value={-sum(persons.filter((b) => b < 0) as Cents[])} /></CardTitle></CardHeader></Card></A>
        <A to="activiteiten"><Card><CardHeader><CardDescription>Nog te verdelen ({openActs.length} activiteiten)</CardDescription><CardTitle className="text-xl"><Money value={sum(openActs.map((a) => d.activityBalance.get(a.id) ?? cents(0)))} /></CardTitle></CardHeader></Card></A>
        <A to="rapporten"><Card><CardHeader><CardDescription>Resultaat dit boekjaar</CardDescription><CardTitle className="text-xl"><Money value={pnl} /></CardTitle></CardHeader></Card></A>
        <A to="contributie"><Card><CardHeader><CardDescription>Contributie nog te ontvangen</CardDescription><CardTitle className="text-xl"><Money value={contributionOpen} /></CardTitle></CardHeader></Card></A>
        <A to="spaarplannen"><Card><CardHeader><CardDescription>Spaargeld van leden (bewaard)</CardDescription><CardTitle className="text-xl"><Money value={savingsTotal} /></CardTitle></CardHeader></Card></A>
      </div>
      <Card>
        <CardHeader><CardTitle>Te doen</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Todo ok={d.unassigned.length === 0} to="bank">{d.unassigned.length === 0 ? "Alle bankregels toegewezen" : `${d.unassigned.length} bankregels toewijzen`}</Todo>
          <Todo ok={pendingClaims === 0} to="declaraties">{pendingClaims === 0 ? "Geen declaraties die wachten" : `${pendingClaims} declaratie(s) beoordelen`}</Todo>
          <Todo ok={contributionDone} to="contributie">{contributionDone ? `Contributie ${formatMonthNl(thisMonth)} opgelegd` : `Contributie ${formatMonthNl(thisMonth)} opleggen`}</Todo>
          <Todo ok={d.unassigned.length === 0} to="debiteuren">Maandmail versturen {d.unassigned.length > 0 && "(pas als de boekhouding bij is)"}</Todo>
        </CardContent>
      </Card>
    </div>
  );
}

function Todo({ ok, to, children }: { ok: boolean; to: string; children: React.ReactNode }) {
  return (
    <A to={to} className="flex items-center gap-2">
      {ok ? <CheckCircle2 className="size-4 text-emerald-600" /> : <AlertTriangle className="size-4 text-amber-600" />}
      {children}
    </A>
  );
}

// ---------------------------------------------------------------------------
// Person statements and the monthly mail
// ---------------------------------------------------------------------------

export type Ledger = "account" | "contribution" | "savings";
const LEDGER_KEYS: Record<Ledger, string[]> = {
  account: ["MEMBER_ACCOUNTS", "EXTERNAL_ACCOUNTS", "ACCOUNTS_PAYABLE"],
  contribution: ["CONTRIBUTION_RECEIVABLE"],
  savings: ["MEMBER_SAVINGS"],
};

/** A person's mutations on one of their three ledgers, oldest first, with running balance. */
export function statementLines(state: State, partyId: string, ledger: Ledger = "account") {
  let running = 0;
  const accounts = new Set(state.accounts.filter((a) => a.systemKey && LEDGER_KEYS[ledger].includes(a.systemKey)).map((a) => a.id));
  const sign = ledger === "savings" ? -1 : 1; // savings: positive = saved
  const rows = state.entries
    .flatMap((e) => e.lines.filter((l) => l.partyId === partyId && accounts.has(l.accountId)).map((l) => ({ e, l: { ...l, amount: cents(sign * l.amount) } })))
    .sort((a, b) => (a.e.date === b.e.date ? (a.e.entryNumber < b.e.entryNumber ? -1 : 1) : a.e.date < b.e.date ? -1 : 1))
    .map(({ e, l }) => {
      running += l.amount;
      const description = l.description ?? e.description;
      const act = l.activityId ? state.activities.find((a) => a.id === l.activityId) : null;
      const goal = l.savingsGoalId ? state.savingsGoals.find((g) => g.id === l.savingsGoalId)?.name : null;
      const name = act ? `${act.number} ${act.name}` : goal;
      const activity = name && !description.includes(act?.name ?? name) ? name : null;
      return { id: `${e.id}-${e.lines.indexOf(l)}`, date: e.date, description, activity, amount: l.amount, balance: cents(running), reversal: !!e.reversesEntryId };
    });
  return rows;
}

export function owedBy(d: ReturnType<typeof import("../ledger").derive>, partyId: string) {
  const account = d.partyBalance.get(partyId) ?? cents(0);
  const contribution = d.contributionBalance.get(partyId) ?? cents(0);
  return { account, contribution, total: cents(account + contribution), savings: d.savingsByParty.get(partyId) ?? cents(0) };
}

export function monthlyMail(state: State, party: Party, month: LocalDate) {
  const start = firstOfMonth(month);
  const end = addMonths(start, 1);
  const section = (ledger: Ledger) => {
    const rows = statementLines(state, party.id, ledger);
    return {
      opening: rows.filter((r) => r.date < start).at(-1)?.balance ?? cents(0),
      inMonth: rows.filter((r) => r.date >= start && r.date < end),
      closing: rows.filter((r) => r.date < end).at(-1)?.balance ?? cents(0),
    };
  };
  const account = section("account");
  const contribution = section("contribution");
  const savings = section("savings");
  const fmtRow = (r: { date: LocalDate; description: string; activity: string | null; amount: number }) =>
    `  ${formatDateNl(r.date)}  ${r.description}${r.activity ? ` (${r.activity})` : ""}: ${r.amount > 0 ? "+" : "-"}${formatEuro(cents(Math.abs(r.amount)))}`;
  const total = cents(Math.max(0, account.closing) + Math.max(0, contribution.closing));
  const lines = [
    `Hoi ${party.member?.firstName ?? party.name},`,
    "",
    `Hierbij je overzicht van ${state.settings.name} over ${formatMonthNl(start)}.`,
    "",
    `REKENING (borrels, activiteiten, declaraties)`,
    `  Begin: ${formatEuro(account.opening)}`,
    ...account.inMonth.map(fmtRow),
    `  Eind: ${formatEuro(account.closing)}${account.closing < 0 ? " (tegoed)" : ""}`,
  ];
  if (party.member) {
    lines.push("", "CONTRIBUTIE", ...contribution.inMonth.map(fmtRow), `  Nog te betalen: ${formatEuro(cents(Math.max(0, contribution.closing)))}${contribution.closing < 0 ? ` (je hebt ${formatEuro(cents(-contribution.closing))} vooruitbetaald)` : ""}`);
    if (savings.closing !== 0 || savings.inMonth.length) {
      lines.push("", "SPAARPLAN", ...savings.inMonth.map(fmtRow), `  Gespaard: ${formatEuro(savings.closing)}`);
    }
  }
  lines.push(
    "",
    total > 0
      ? `Wil je ${formatEuro(total)} overmaken naar ${formatIban(state.settings.paymentIban)} t.n.v. ${state.settings.paymentAccountName}, o.v.v. je naam${contribution.closing > 0 && account.closing > 0 ? ` (${formatEuro(contribution.closing)} contributie + ${formatEuro(account.closing)} rekening)` : contribution.closing > 0 ? " en \"contributie\"" : ""}? Dank je!`
      : "Je hoeft deze maand niets over te maken. Top!",
    "",
    "Groet,",
    "De fiscus",
  );
  return { subject: `${state.settings.name}: je overzicht ${formatMonthNl(start)}`, body: lines.join("\n"), closing: total, count: account.inMonth.length + contribution.inMonth.length };
}

export function DebtorsPage() {
  const { state, d } = useLedger();
  const [showAll, setShowAll] = useState(false);
  const [month, setMonth] = useState(firstOfMonth(addMonths(today(), -1)).slice(0, 7));
  const [kind, setKind] = useState<"all" | "member" | "external">("all");
  const persons = state.parties
    .map((p) => ({ p, ...owedBy(d, p.id), balance: owedBy(d, p.id).total }))
    .filter((x) => kind === "all" || x.p.kind === kind)
    .filter((x) => showAll || x.balance !== 0 || x.account !== 0)
    .sort((a, b) => b.balance - a.balance);
  const openActs = state.activities.filter((a) => a.status === "open");
  const booksUpToDate = d.unassigned.length === 0;
  const withMail = state.parties.filter((p) => p.email && owedBy(d, p.id).total !== 0);

  const exportCsv = () => {
    const eur = (v: number) => (v / 100).toFixed(2).replace(".", ",");
    const lines = [csvLine(["Naam", "Soort", "Rekening", "Contributie", "Totaal te betalen (negatief = tegoed)", "Spaargeld"]), ...persons.map((x) => csvLine([x.p.name, x.p.kind === "member" ? "Lid" : "Extern", eur(x.account), eur(x.contribution), eur(x.balance), eur(x.savings)]))];
    download(`debiteurenlijst-${today()}.csv`, "﻿" + lines.join("\r\n"));
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Debiteurenlijst" description="Wat iedereen het dispuut nog moet betalen (rood) of tegoed heeft (groen), en wat nog verdeeld moet worden.">
        <Button variant="outline" onClick={exportCsv}><Download /> Excel/CSV</Button>
        <Button variant="outline" onClick={() => window.print()}><Printer /> Afdrukken</Button>
      </PageHeader>

      <BulkCharge />

      <Card className="print:hidden">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Mail className="size-5" /> Maandmail</CardTitle>
          <CardDescription>Iedereen met een saldo en een e-mailadres krijgt een overzicht van de maand en wat hij/zij moet overmaken.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Maand"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" /></Field>
            <span className="pb-2 text-muted-foreground">{withMail.length} ontvangers</span>
          </div>
          {!booksUpToDate ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:bg-amber-950/40">
              Eerst de boekhouding bijwerken: er zijn nog {d.unassigned.length} bankregels niet toegewezen. Anders krijgt iemand misschien een verkeerd bedrag.
            </div>
          ) : (
            <p>Open per persoon het overzicht en klik op <strong>Mail openen</strong> (je eigen mailprogramma), of kopieer de tekst. In de echte versie gaat dit automatisch.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Personen</CardTitle>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            {(["all", "member", "external"] as const).map((k) => <Button key={k} size="sm" variant={kind === k ? "default" : "outline"} onClick={() => setKind(k)}>{k === "all" ? "Iedereen" : k === "member" ? "Leden" : "Externen"}</Button>)}
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Ook € 0</label>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Naam</TableHead><TableHead className="text-right">Rekening</TableHead><TableHead className="text-right">Contributie</TableHead><TableHead className="text-right">Totaal te betalen</TableHead><TableHead className="text-right">Spaargeld</TableHead><TableHead className="print:hidden" /></TableRow></TableHeader>
            <TableBody>
              {persons.map(({ p, balance, account, contribution, savings }) => (
                <TableRow key={p.id}>
                  <TableCell><A to={`persoon/${p.id}`}>{p.name}</A>{p.kind === "external" && <Badge variant="outline" className="ml-2">extern</Badge>}</TableCell>
                  <TableCell className="text-right"><Money value={account} tone /></TableCell>
                  <TableCell className="text-right">{p.kind === "member" ? <Money value={contribution} tone /> : ""}</TableCell>
                  <TableCell className="text-right font-medium"><Money value={balance} tone /><span className="ml-2 text-xs text-muted-foreground">{balance > 0 ? "moet betalen" : balance < 0 ? "tegoed" : ""}</span></TableCell>
                  <TableCell className="text-right text-muted-foreground">{savings !== 0 && <Money value={savings} />}</TableCell>
                  <TableCell className="text-right print:hidden">
                    <Button variant="ghost" size="sm" onClick={() => go(`persoon/${p.id}?maand=${month}`)}>Overzicht</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell>Totaal</TableCell>
                <TableCell className="text-right"><Money value={sum(persons.map((x) => x.account))} /></TableCell>
                <TableCell className="text-right"><Money value={sum(persons.map((x) => x.contribution))} /></TableCell>
                <TableCell className="text-right"><Money value={sum(persons.filter((x) => x.balance > 0).map((x) => x.balance))} /> te ontvangen</TableCell>
                <TableCell className="text-right"><Money value={sum(persons.map((x) => x.savings))} /></TableCell>
                <TableCell className="print:hidden" />
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Nog te verdelen</CardTitle><CardDescription>Uitgaven voor activiteiten die nog niet over de deelnemers zijn verdeeld.</CardDescription></CardHeader>
        <CardContent className="p-0">
          {openActs.length === 0 ? <Empty>Niets te verdelen.</Empty> : (
            <Table>
              <TableBody>
                {openActs.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell><A to={`activiteit/${a.id}`}><span className="font-mono text-xs text-muted-foreground">{a.number}</span> {a.name}</A></TableCell>
                    <TableCell>{a.heldOn ? formatDateNl(a.heldOn) : "—"}</TableCell>
                    <TableCell className="text-right"><Money value={d.activityBalance.get(a.id) ?? 0} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function StatementTable({ partyId, ledger = "account" }: { partyId: string; ledger?: Ledger }) {
  const { state } = useLedger();
  const rows = statementLines(state, partyId, ledger);
  if (!rows.length) return <Empty>Nog geen mutaties.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Datum</TableHead><TableHead>Omschrijving</TableHead><TableHead className="text-right">{ledger === "savings" ? "Ingelegd" : ledger === "contribution" ? "Opgelegd" : "Voorgeschoten"}</TableHead><TableHead className="text-right">{ledger === "savings" ? "Gebruikt / uitbetaald" : "Betaald / tegoed"}</TableHead><TableHead className="text-right">{ledger === "savings" ? "Gespaard" : "Saldo"}</TableHead></TableRow></TableHeader>
      <TableBody>
        {[...rows].reverse().map((r) => (
          <TableRow key={r.id}>
            <TableCell className="whitespace-nowrap">{formatDateNl(r.date)}</TableCell>
            <TableCell>{r.description}{r.activity && <span className="text-muted-foreground"> · {r.activity}</span>}{r.reversal && <Badge variant="warning" className="ml-2">correctie</Badge>}</TableCell>
            <TableCell className="text-right">{r.amount > 0 && <Money value={r.amount} />}</TableCell>
            <TableCell className="text-right">{r.amount < 0 && <Money value={-r.amount} />}</TableCell>
            <TableCell className="text-right font-medium"><Money value={r.balance} tone={ledger !== "savings"} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function BalanceText({ balance, contribution = cents(0) }: { balance: Cents; contribution?: Cents }) {
  const { state } = useLedger();
  const total = cents(Math.max(0, balance) + Math.max(0, contribution));
  if (contribution !== 0) {
    return (
      <div className="flex flex-col gap-1">
        <p>Rekening: <Money value={balance} tone /> · Contributie: <Money value={contribution} tone /></p>
        {total > 0 ? <p>Maak <strong className="text-red-700 dark:text-red-400">{formatEuro(total)}</strong> over naar <strong>{formatIban(state.settings.paymentIban)}</strong> t.n.v. {state.settings.paymentAccountName}, o.v.v. je naam.</p> : <p>Je hoeft niets over te maken.</p>}
      </div>
    );
  }
  if (balance > 0) return <p>Openstaand: <strong className="text-red-700 dark:text-red-400">{formatEuro(balance)}</strong>. Maak dit over naar <strong>{formatIban(state.settings.paymentIban)}</strong> t.n.v. {state.settings.paymentAccountName}, o.v.v. je naam.</p>;
  if (balance < 0) return <p>Tegoed: <strong className="text-emerald-700 dark:text-emerald-400">{formatEuro(cents(-balance))}</strong>.</p>;
  return <p>Precies op nul.</p>;
}

export function PersonPage({ id, monthParam }: { id: string; monthParam?: string }) {
  const { state, d } = useLedger();
  const { notify } = useApp();
  const party = d.partyById.get(id);
  const [month, setMonth] = useState(monthParam ?? firstOfMonth(addMonths(today(), -1)).slice(0, 7));
  const mail = useMemo(() => (party ? monthlyMail(state, party, localDate(`${month}-01`)) : null), [state, party, month]);
  if (!party || !mail) return <Empty>Persoon niet gevonden.</Empty>;
  const owed = owedBy(d, party.id);
  const balance = owed.total;
  const goals = state.savingsGoals.filter((g) => (d.savings.get(`${party.id}|${g.id}`) ?? 0) !== 0);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={party.name} description={party.kind === "member" ? `Lid · ${state.memberTypes.find((t) => t.id === party.member?.memberTypeId)?.name ?? ""}` : "Extern"}>
        <div className="text-right"><div className="text-xs text-muted-foreground">Saldo</div><div className="text-2xl font-semibold"><Money value={balance} tone /></div></div>
      </PageHeader>
      <Card className="print:hidden">
        <CardHeader><CardTitle className="flex items-center gap-2"><Mail className="size-5" /> Maandoverzicht</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Maand"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" /></Field>
            <Button variant="outline" onClick={() => { void navigator.clipboard?.writeText(mail.body); notify("Tekst gekopieerd", "ok"); }}><Copy /> Kopieer tekst</Button>
            {party.email ? (
              <Button asChild><a href={`mailto:${party.email}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body)}`}><Mail /> Mail openen</a></Button>
            ) : <span className="pb-2 text-sm text-muted-foreground">Geen e-mailadres bekend</span>}
          </div>
          {d.unassigned.length > 0 && <p className="text-sm text-amber-700">Let op: er zijn nog {d.unassigned.length} bankregels niet toegewezen; het saldo kan nog veranderen.</p>}
          <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-sans text-sm">{mail.body}</pre>
        </CardContent>
      </Card>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardHeader><CardDescription>Rekening</CardDescription><CardTitle className="text-xl"><Money value={owed.account} tone /></CardTitle></CardHeader></Card>
        {party.member && <Card><CardHeader><CardDescription>Contributie open</CardDescription><CardTitle className="text-xl"><Money value={owed.contribution} tone /></CardTitle></CardHeader></Card>}
        {party.member && <Card><CardHeader><CardDescription>Spaargeld</CardDescription><CardTitle className="text-xl"><Money value={owed.savings} /></CardTitle><CardDescription className="text-xs">{goals.map((g) => `${g.name}: ${formatEuro(d.savings.get(`${party.id}|${g.id}`) ?? cents(0))}`).join(" · ")}</CardDescription></CardHeader></Card>}
      </div>
      <Card>
        <CardHeader><CardTitle>Rekening</CardTitle><CardDescription>Borrels, activiteiten, declaraties en betalingen.</CardDescription></CardHeader>
        <CardContent className="p-0"><StatementTable partyId={party.id} /></CardContent>
      </Card>
      {party.member && (
        <Card>
          <CardHeader><CardTitle>Contributie</CardTitle></CardHeader>
          <CardContent className="p-0"><StatementTable partyId={party.id} ledger="contribution" /></CardContent>
        </Card>
      )}
      {party.member && owed.savings !== 0 && (
        <Card>
          <CardHeader><CardTitle>Spaarplan</CardTitle></CardHeader>
          <CardContent className="p-0"><StatementTable partyId={party.id} ledger="savings" /></CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Members, member types, externals
// ---------------------------------------------------------------------------

export function MembersPage() {
  const { state, d } = useLedger();
  const canEdit = useCan("edit");
  const isAdmin = useCan("admin");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const members = state.parties.filter((p) => p.member).sort((a, b) => (b.member!.cohort ?? 0) - (a.member!.cohort ?? 0) || a.name.localeCompare(b.name));
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Leden" description={`${members.filter((m) => m.active).length} actieve leden`}>
        {canEdit && <Button onClick={() => setAdding((v) => !v)}><UserPlus /> Lid toevoegen</Button>}
      </PageHeader>
      <ReadOnlyNotice />
      {adding && <MemberForm onDone={() => setAdding(false)} />}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Naam</TableHead><TableHead>Jaargang</TableHead><TableHead>Soort lid</TableHead><TableHead className="text-right">Per maand</TableHead><TableHead className="text-right">Saldo</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {members.map((m) => {
                const type = state.memberTypes.find((t) => t.id === m.member!.memberTypeId);
                return editing === m.id ? (
                  <TableRow key={m.id}><TableCell colSpan={6}><MemberEdit party={m} onDone={() => setEditing(null)} /></TableCell></TableRow>
                ) : (
                  <TableRow key={m.id} className={m.active ? "" : "opacity-60"}>
                    <TableCell>
                      <A to={`persoon/${m.id}`}>{m.name}</A>
                      {!m.active && <Badge variant="outline" className="ml-2">uitgeschreven</Badge>}
                      <div className="text-xs text-muted-foreground">{m.email ?? "geen e-mail"}{m.ibans.length > 0 && ` · ${m.ibans.map(formatIban).join(", ")}`}</div>
                    </TableCell>
                    <TableCell>{m.member!.cohort ?? "—"}</TableCell>
                    <TableCell><Badge variant="secondary">{type?.name}</Badge></TableCell>
                    <TableCell className="text-right"><Money value={type?.monthly ?? 0} /></TableCell>
                    <TableCell className="text-right"><Money value={owedBy(d, m.id).total} tone /></TableCell>
                    <TableCell className="text-right">{canEdit && <Button variant="ghost" size="sm" onClick={() => setEditing(m.id)}>Wijzigen</Button>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Soorten leden</CardTitle><CardDescription>Zelf aan te maken, elk met een eigen contributie per maand.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Table>
              <TableBody>
                {state.memberTypes.map((t) => <MemberTypeRow key={t.id} id={t.id} />)}
              </TableBody>
            </Table>
            {isAdmin && <NewMemberType />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Externen</CardTitle><CardDescription>Andere disputen, sponsoren, leveranciers en gasten staan op een eigen pagina.</CardDescription></CardHeader>
          <CardContent><A to="externen" className="text-sm font-medium">Naar Externen →</A></CardContent>
        </Card>
      </div>
    </div>
  );
}

function MemberForm({ onDone }: { onDone: () => void }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const run = useAction();
  const [f, setF] = useState({ firstName: "", lastName: "", email: "", memberTypeId: state.memberTypes[0]?.id ?? "", cohort: String(new Date().getFullYear()), joinedOn: today() as string, iban: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card>
      <CardHeader><CardTitle>Nieuw lid</CardTitle></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <Field label="Voornaam"><Input value={f.firstName} onChange={set("firstName")} /></Field>
        <Field label="Achternaam"><Input value={f.lastName} onChange={set("lastName")} /></Field>
        <Field label="E-mail"><Input type="email" value={f.email} onChange={set("email")} /></Field>
        <Field label="Soort lid"><Select value={f.memberTypeId} onChange={set("memberTypeId")}>{state.memberTypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({formatEuro(t.monthly)}/mnd)</option>)}</Select></Field>
        <Field label="Jaargang"><Input value={f.cohort} onChange={set("cohort")} inputMode="numeric" /></Field>
        <Field label="Lid sinds"><Input type="date" value={f.joinedOn} onChange={set("joinedOn")} /></Field>
        <Field label="IBAN (optioneel)" className="sm:col-span-2"><Input value={f.iban} onChange={set("iban")} placeholder="NL.." /></Field>
        <div className="flex items-end gap-2">
          <Button onClick={() => run(() => { store.createMember({ firstName: f.firstName, lastName: f.lastName, email: f.email, memberTypeId: f.memberTypeId, cohort: f.cohort ? Number(f.cohort) : null, joinedOn: localDate(f.joinedOn), ibans: f.iban ? [f.iban] : [] }, actor); onDone(); }, "Lid toegevoegd")}>Toevoegen</Button>
          <Button variant="ghost" onClick={onDone}>Annuleren</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MemberEdit({ party, onDone }: { party: Party; onDone: () => void }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const run = useAction();
  const [f, setF] = useState({ firstName: party.member!.firstName, lastName: party.member!.lastName, email: party.email ?? "", memberTypeId: party.member!.memberTypeId, cohort: String(party.member!.cohort ?? ""), ibans: party.ibans.join(", "), leftOn: party.member!.leftOn ?? "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="grid gap-3 py-2 sm:grid-cols-5">
      <Field label="Voornaam"><Input value={f.firstName} onChange={set("firstName")} /></Field>
      <Field label="Achternaam"><Input value={f.lastName} onChange={set("lastName")} /></Field>
      <Field label="E-mail"><Input value={f.email} onChange={set("email")} /></Field>
      <Field label="Soort lid" hint="Per maand afwijken: Contributie → Ledenplanning"><Select value={f.memberTypeId} onChange={set("memberTypeId")}>{state.memberTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
      <Field label="Jaargang"><Input value={f.cohort} onChange={set("cohort")} /></Field>
      <Field label="IBAN(s), komma-gescheiden"><Input value={f.ibans} onChange={set("ibans")} /></Field>
      <Field label="Uitgeschreven per" hint="Leeg = actief lid"><Input type="date" value={f.leftOn} onChange={set("leftOn")} /></Field>
      <div className="flex gap-2 sm:col-span-5">
        <Button size="sm" onClick={() => run(() => { store.updateMember(party.id, { firstName: f.firstName, lastName: f.lastName, email: f.email || null, memberTypeId: f.memberTypeId, cohort: f.cohort ? Number(f.cohort) : null, ibans: f.ibans.split(",").map((x) => x.trim()).filter(Boolean), leftOn: f.leftOn ? localDate(f.leftOn) : null }, actor); onDone(); }, "Opgeslagen")}>Opslaan</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Annuleren</Button>
      </div>
    </div>
  );
}

function MemberTypeRow({ id }: { id: string }) {
  const { state } = useLedger();
  const isAdmin = useCan("admin");
  const t = state.memberTypes.find((x) => x.id === id)!;
  const count = state.parties.filter((p) => p.active && p.member?.memberTypeId === id).length;
  const [edit, setEdit] = useState(false);
  const potName = (pid: string | null | undefined) => state.pots.find((p) => p.id === pid)?.name;
  if (edit) {
    return (
      <TableRow>
        <TableCell colSpan={3}><MemberTypeEditor type={t} onDone={() => setEdit(false)} /></TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow>
      <TableCell>
        {t.name} <span className="text-xs text-muted-foreground">({count} leden)</span>
        {(t.split?.length || t.restPotId) ? (
          <div className="text-xs text-muted-foreground">
            {(t.split ?? []).map((p) => `${potName(p.potId)} ${formatEuro(p.amount)}`).join(" · ")}
            {t.restPotId && `${t.split?.length ? " · " : ""}rest naar ${potName(t.restPotId)}`}
          </div>
        ) : null}
      </TableCell>
      <TableCell><Money value={t.monthly} /> / mnd</TableCell>
      <TableCell className="text-right">{isAdmin && <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>Wijzigen</Button>}</TableCell>
    </TableRow>
  );
}

/** Edit a member type: contribution, fixed parts per pot (e.g. woonkamer, bier) and the rest pot. */
function MemberTypeEditor({ type, onDone }: { type: MemberType; onDone: () => void }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const run = useAction();
  const euro = (c: number) => (c / 100).toFixed(2).replace(".", ",");
  const [name, setName] = useState(type.name);
  const [amount, setAmount] = useState(euro(type.monthly));
  const [parts, setParts] = useState<{ potId: string; amount: string }[]>((type.split ?? []).map((p) => ({ potId: p.potId, amount: euro(p.amount) })));
  const [restPotId, setRestPotId] = useState(type.restPotId ?? "");
  const [paysGeneral, setPaysGeneral] = useState(type.paysGeneral ?? false);
  const [paysYoung, setPaysYoung] = useState(type.paysYoung ?? false);
  const [rateLike, setRateLike] = useState(type.rateLikeTypeId ?? "");
  return (
    <div className="flex flex-col gap-3 py-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Naam"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Contributie per maand"><Input value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      </div>
      <div className="text-sm font-medium">Vaste delen per potje <span className="font-normal text-muted-foreground">(bijv. woonkamer € 5,50 en bier € 15,00)</span></div>
      {parts.map((p, i) => (
        <div key={i} className="flex gap-2">
          <Select value={p.potId} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, potId: e.target.value } : x)))}>
            {state.pots.map((pot) => <option key={pot.id} value={pot.id}>{pot.name}</option>)}
          </Select>
          <Input value={p.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} className="w-28" />
          <Button variant="ghost" size="sm" onClick={() => setParts(parts.filter((_, j) => j !== i))}>Weg</Button>
        </div>
      ))}
      <div><Button variant="outline" size="sm" onClick={() => setParts([...parts, { potId: state.pots[0].id, amount: "" }])}>Vast deel toevoegen</Button></div>
      <Field label="De rest gaat naar" hint="Leeg = volgens de algemene contributieverdeling (Contributie → Verdeling)">
        <Select value={restPotId} onChange={(e) => setRestPotId(e.target.value)}>
          <option value="">Algemene verdeling</option>
          {state.pots.map((pot) => <option key={pot.id} value={pot.id}>{pot.name}</option>)}
        </Select>
      </Field>
      <div className="text-sm font-medium">Voor het berekenen van de contributie uit de begroting</div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={paysGeneral} onChange={(e) => setPaysGeneral(e.target.checked)} /> Betaalt mee aan de posten voor alle leden</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={paysYoung} onChange={(e) => setPaysYoung(e.target.checked)} /> Betaalt mee aan de jongerejaarsposten</label>
      <Field label="Of: zelfde tarief als" hint="Bijv. nieuwe lichting betaalt het jongerejaarstarief; het deel boven de vaste delen gaat naar het rest-potje (truien)">
        <Select value={rateLike} onChange={(e) => setRateLike(e.target.value)}>
          <option value="">—</option>
          {state.memberTypes.filter((x) => x.id !== type.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </Select>
      </Field>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => run(() => {
          store.updateMemberType(type.id, {
            name, monthly: parseAmount(amount), split: parts.filter((p) => p.amount.trim()).map((p) => ({ potId: p.potId, amount: parseAmount(p.amount) })),
            restPotId: restPotId || null, paysGeneral, paysYoung, rateLikeTypeId: rateLike || null,
          }, actor);
          onDone();
        }, "Opgeslagen (geldt vanaf de volgende contributiemaand)")}>Opslaan</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Annuleren</Button>
      </div>
    </div>
  );
}

function NewMemberType() {
  const { store, actor } = useApp();
  const run = useAction();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  return (
    <div className="flex gap-2">
      <Input placeholder="Nieuwe soort, bijv. Donateur" value={name} onChange={(e) => setName(e.target.value)} />
      <Input placeholder="€/mnd" value={amount} onChange={(e) => setAmount(e.target.value)} className="w-24" />
      <Button onClick={() => run(() => { store.createMemberType({ name, monthly: amount ? parseAmount(amount) : cents(0) }, actor); setName(""); setAmount(""); }, "Soort lid toegevoegd")}>Toevoegen</Button>
    </div>
  );
}


export function useLineTarget() {
  const { state, d } = useLedger();
  return (l: Parameters<typeof lineTarget>[2]) => lineTarget(state, d, l);
}

/** A column of the old "Ledenrekening" sheet: an amount per member for one item, booked in one go. */
function BulkCharge() {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const canEdit = useCan("edit");
  const run = useAction();
  const [open, setOpen] = useState(false);
  const targets = [
    ...state.activities.filter((a) => a.status === "open").map((a) => ({ value: `activity:${a.id}`, label: `${a.number} ${a.name}` })),
    ...state.pots.map((p) => ({ value: `pot:${p.id}`, label: `Potje ${p.name}` })),
  ];
  const [f, setF] = useState({ target: "", description: "", price: "", date: today() as string });
  const [values, setValues] = useState<Record<string, string>>({});
  if (!canEdit) return null;
  const members = state.parties.filter((p) => p.kind === "member" && p.active).sort((a, b) => a.name.localeCompare(b.name));
  const amountFor = (raw: string): Cents => {
    if (!raw.trim()) return cents(0);
    if (!f.price.trim()) return parseAmount(raw);
    return cents(Math.round((parseAmount(f.price) * parseHundredths(raw)) / 100));
  };
  let total = 0;
  let error = "";
  try {
    total = sum(members.map((m) => amountFor(values[m.id] ?? "")));
  } catch (e) {
    error = (e as Error).message;
  }
  return (
    <Card className="print:hidden">
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
        <div>
          <CardTitle>Bedragen op ledenrekeningen zetten</CardTitle>
          <CardDescription>Zoals een kolom in de oude ledenrekening: turflijst, een gedeelde maaltijd, drankjes, extra bij/af. Met een prijs per stuk vul je het aantal in (bijv. streepjes); zonder prijs het bedrag (negatief = tegoed).</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setOpen((v) => !v)}>{open ? "Verbergen" : "Openen"}</Button>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Omschrijving"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Turf juni" /></Field>
            <Field label="Opbrengst naar"><Select value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })}><option value="">Kies…</option>{targets.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select></Field>
            <Field label="Prijs per stuk (optioneel)"><Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} placeholder="0,70" /></Field>
            <Field label="Datum"><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
          </div>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {members.map((m) => (
              <label key={m.id} className="flex items-center justify-between gap-2 text-sm">
                <span>{m.name}</span>
                <Input value={values[m.id] ?? ""} onChange={(e) => setValues({ ...values, [m.id]: e.target.value })} className="h-8 w-24 text-right" placeholder={f.price ? "aantal" : "0,00"} inputMode="decimal" />
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm">{error ? <span className="text-red-600">{error}</span> : <>Totaal {formatEuro(cents(total))}</>}</span>
            <Button disabled={!!error || !total || !f.target} onClick={() => run(() => {
              const [kind, id] = f.target.split(":") as ["activity" | "pot", string];
              store.chargeMany({ date: localDate(f.date), target: { kind, id }, description: f.description, items: members.map((m) => ({ partyId: m.id, amount: amountFor(values[m.id] ?? "") })) }, actor);
              setValues({});
            }, "Op de rekeningen gezet")}>Boeken</Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
