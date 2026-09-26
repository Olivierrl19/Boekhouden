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
import { currentFiscalYear, resultByPot, today, type Party, type State } from "../ledger";
import { A, Empty, Field, PageHeader, ReadOnlyNotice, Select, csvLine, download, go, parseAmount, useAction, useApp, useCan, useLedger } from "./core";
import { lineTarget } from "./labels";

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export function DashboardPage() {
  const { state, d } = useLedger();
  const fy = currentFiscalYear(state, today());
  const persons = state.parties.map((p) => d.partyBalance.get(p.id) ?? 0);
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
      </div>
      <Card>
        <CardHeader><CardTitle>Te doen</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <Todo ok={d.unassigned.length === 0} to="bank">{d.unassigned.length === 0 ? "Alle bankregels toegewezen" : `${d.unassigned.length} bankregels toewijzen`}</Todo>
          <Todo ok={pendingClaims === 0} to="declaraties">{pendingClaims === 0 ? "Geen declaraties die wachten" : `${pendingClaims} declaratie(s) beoordelen`}</Todo>
          <Todo ok={contributionDone} to="contributie">{contributionDone ? `Contributie ${formatMonthNl(thisMonth)} geboekt` : `Contributie ${formatMonthNl(thisMonth)} boeken`}</Todo>
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

export function statementLines(state: State, partyId: string) {
  let running = 0;
  const rows = state.entries
    .flatMap((e) => e.lines.filter((l) => l.partyId === partyId).map((l) => ({ e, l })))
    .sort((a, b) => (a.e.date === b.e.date ? (a.e.entryNumber < b.e.entryNumber ? -1 : 1) : a.e.date < b.e.date ? -1 : 1))
    .map(({ e, l }) => {
      running += l.amount;
      const description = l.description ?? e.description;
      const name = l.activityId ? state.activities.find((a) => a.id === l.activityId)?.name : null;
      const activity = name && !description.includes(name) ? name : null;
      return { id: `${e.id}-${e.lines.indexOf(l)}`, date: e.date, description, activity, amount: l.amount, balance: cents(running), reversal: !!e.reversesEntryId };
    });
  return rows;
}

export function monthlyMail(state: State, party: Party, month: LocalDate) {
  const start = firstOfMonth(month);
  const end = addMonths(start, 1);
  const rows = statementLines(state, party.id);
  const opening = rows.filter((r) => r.date < start).at(-1)?.balance ?? cents(0);
  const inMonth = rows.filter((r) => r.date >= start && r.date < end);
  const closing = rows.filter((r) => r.date < end).at(-1)?.balance ?? cents(0);
  const lines = [
    `Hoi ${party.member?.firstName ?? party.name},`,
    "",
    `Hierbij je overzicht van ${state.settings.name} over ${formatMonthNl(start)}.`,
    "",
    `Beginsaldo: ${formatEuro(opening)}`,
    ...inMonth.map((r) => `${formatDateNl(r.date)}  ${r.description}${r.activity ? ` (${r.activity})` : ""}: ${r.amount > 0 ? "+" : "-"}${formatEuro(cents(Math.abs(r.amount)))}`),
    `Eindsaldo: ${formatEuro(closing)}`,
    "",
    closing > 0
      ? `Wil je ${formatEuro(closing)} overmaken naar ${formatIban(state.settings.paymentIban)} t.n.v. ${state.settings.paymentAccountName}, o.v.v. je naam? Dank je!`
      : closing < 0
        ? `Je hebt een tegoed van ${formatEuro(cents(-closing))}. Dat verrekenen we met je volgende kosten.`
        : "Je staat precies op nul. Top!",
    "",
    "Groet,",
    "De fiscus",
  ];
  return { subject: `${state.settings.name}: je overzicht ${formatMonthNl(start)}`, body: lines.join("\n"), closing, count: inMonth.length };
}

export function DebtorsPage() {
  const { state, d } = useLedger();
  const [showAll, setShowAll] = useState(false);
  const [month, setMonth] = useState(firstOfMonth(addMonths(today(), -1)).slice(0, 7));
  const persons = state.parties
    .map((p) => ({ p, balance: d.partyBalance.get(p.id) ?? cents(0) }))
    .filter((x) => showAll || x.balance !== 0)
    .sort((a, b) => b.balance - a.balance);
  const openActs = state.activities.filter((a) => a.status === "open");
  const booksUpToDate = d.unassigned.length === 0;
  const withMail = state.parties.filter((p) => p.email && (d.partyBalance.get(p.id) ?? 0) !== 0);

  const exportCsv = () => {
    const lines = [csvLine(["Naam", "Soort", "Saldo (positief = moet betalen)"]), ...persons.map(({ p, balance }) => csvLine([p.name, p.kind === "member" ? "Lid" : "Extern", (balance / 100).toFixed(2).replace(".", ",")]))];
    download(`debiteurenlijst-${today()}.csv`, "﻿" + lines.join("\r\n"));
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Debiteurenlijst" description="Wat iedereen het dispuut nog moet betalen (rood) of tegoed heeft (groen), en wat nog verdeeld moet worden.">
        <Button variant="outline" onClick={exportCsv}><Download /> Excel/CSV</Button>
        <Button variant="outline" onClick={() => window.print()}><Printer /> Afdrukken</Button>
      </PageHeader>

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
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Personen</CardTitle>
          <label className="flex items-center gap-2 text-sm print:hidden"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Ook saldo € 0</label>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Naam</TableHead><TableHead>Soort</TableHead><TableHead className="text-right">Saldo</TableHead><TableHead className="print:hidden" /></TableRow></TableHeader>
            <TableBody>
              {persons.map(({ p, balance }) => (
                <TableRow key={p.id}>
                  <TableCell><A to={`persoon/${p.id}`}>{p.name}</A></TableCell>
                  <TableCell><Badge variant={p.kind === "member" ? "secondary" : "outline"}>{p.kind === "member" ? "Lid" : "Extern"}</Badge></TableCell>
                  <TableCell className="text-right"><Money value={balance} tone /><span className="ml-2 text-xs text-muted-foreground">{balance > 0 ? "moet betalen" : balance < 0 ? "tegoed" : ""}</span></TableCell>
                  <TableCell className="text-right print:hidden">
                    <Button variant="ghost" size="sm" onClick={() => go(`persoon/${p.id}?maand=${month}`)}>Overzicht</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>Totaal te ontvangen / tegoeden</TableCell>
                <TableCell className="text-right"><Money value={sum(persons.filter((x) => x.balance > 0).map((x) => x.balance))} /> / <Money value={-sum(persons.filter((x) => x.balance < 0).map((x) => x.balance))} /></TableCell>
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
                    <TableCell><A to={`activiteit/${a.id}`}>{a.name}</A></TableCell>
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

export function StatementTable({ partyId }: { partyId: string }) {
  const { state } = useLedger();
  const rows = statementLines(state, partyId);
  if (!rows.length) return <Empty>Nog geen mutaties.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Datum</TableHead><TableHead>Omschrijving</TableHead><TableHead className="text-right">Voorgeschoten</TableHead><TableHead className="text-right">Betaald / tegoed</TableHead><TableHead className="text-right">Saldo</TableHead></TableRow></TableHeader>
      <TableBody>
        {[...rows].reverse().map((r) => (
          <TableRow key={r.id}>
            <TableCell className="whitespace-nowrap">{formatDateNl(r.date)}</TableCell>
            <TableCell>{r.description}{r.activity && <span className="text-muted-foreground"> · {r.activity}</span>}{r.reversal && <Badge variant="warning" className="ml-2">correctie</Badge>}</TableCell>
            <TableCell className="text-right">{r.amount > 0 && <Money value={r.amount} />}</TableCell>
            <TableCell className="text-right">{r.amount < 0 && <Money value={-r.amount} />}</TableCell>
            <TableCell className="text-right font-medium"><Money value={r.balance} tone /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function BalanceText({ balance }: { balance: Cents }) {
  const { state } = useLedger();
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
  const balance = d.partyBalance.get(party.id) ?? cents(0);
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
      <Card>
        <CardHeader><CardTitle>Rekening</CardTitle></CardHeader>
        <CardContent className="p-0"><StatementTable partyId={party.id} /></CardContent>
      </Card>
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
  const externals = state.parties.filter((p) => p.kind === "external");
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
                    <TableCell className="text-right"><Money value={d.partyBalance.get(m.id) ?? 0} tone /></TableCell>
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
          <CardHeader><CardTitle>Externen</CardTitle><CardDescription>Andere disputen, sponsoren, leveranciers. Ook zij hebben een eigen rekening.</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Table>
              <TableBody>
                {externals.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell><A to={`persoon/${x.id}`}>{x.name}</A><div className="text-xs text-muted-foreground">{x.ibans.map(formatIban).join(", ")}</div></TableCell>
                    <TableCell className="text-right"><Money value={d.partyBalance.get(x.id) ?? 0} tone /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {canEdit && <NewExternal />}
          </CardContent>
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
  const [f, setF] = useState({ email: party.email ?? "", memberTypeId: party.member!.memberTypeId, cohort: String(party.member!.cohort ?? ""), ibans: party.ibans.join(", "), leftOn: party.member!.leftOn ?? "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="grid gap-3 py-2 sm:grid-cols-5">
      <Field label="E-mail"><Input value={f.email} onChange={set("email")} /></Field>
      <Field label="Soort lid"><Select value={f.memberTypeId} onChange={set("memberTypeId")}>{state.memberTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
      <Field label="Jaargang"><Input value={f.cohort} onChange={set("cohort")} /></Field>
      <Field label="IBAN(s), komma-gescheiden"><Input value={f.ibans} onChange={set("ibans")} /></Field>
      <Field label="Uitgeschreven per" hint="Leeg = actief lid"><Input type="date" value={f.leftOn} onChange={set("leftOn")} /></Field>
      <div className="flex gap-2 sm:col-span-5">
        <Button size="sm" onClick={() => run(() => { store.updateMember(party.id, { email: f.email || null, memberTypeId: f.memberTypeId, cohort: f.cohort ? Number(f.cohort) : null, ibans: f.ibans.split(",").map((x) => x.trim()).filter(Boolean), leftOn: f.leftOn ? localDate(f.leftOn) : null }, actor); onDone(); }, "Opgeslagen")}>Opslaan</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Annuleren</Button>
      </div>
    </div>
  );
}

function MemberTypeRow({ id }: { id: string }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const t = state.memberTypes.find((x) => x.id === id)!;
  const count = state.parties.filter((p) => p.active && p.member?.memberTypeId === id).length;
  const [edit, setEdit] = useState(false);
  const [name, setName] = useState(t.name);
  const [amount, setAmount] = useState((t.monthly / 100).toFixed(2).replace(".", ","));
  if (edit) {
    return (
      <TableRow>
        <TableCell><Input value={name} onChange={(e) => setName(e.target.value)} /></TableCell>
        <TableCell><Input value={amount} onChange={(e) => setAmount(e.target.value)} className="w-24" /></TableCell>
        <TableCell className="text-right"><Button size="sm" onClick={() => run(() => { store.updateMemberType(id, { name, monthly: parseAmount(amount) }, actor); setEdit(false); }, "Opgeslagen (geldt vanaf de volgende contributiemaand)")}>Opslaan</Button></TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow>
      <TableCell>{t.name} <span className="text-xs text-muted-foreground">({count} leden)</span></TableCell>
      <TableCell><Money value={t.monthly} /> / mnd</TableCell>
      <TableCell className="text-right">{isAdmin && <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>Wijzigen</Button>}</TableCell>
    </TableRow>
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

function NewExternal() {
  const { store, actor } = useApp();
  const run = useAction();
  const [name, setName] = useState("");
  const [iban, setIban] = useState("");
  return (
    <div className="flex gap-2">
      <Input placeholder="Naam, bijv. Dispuut Bacchus" value={name} onChange={(e) => setName(e.target.value)} />
      <Input placeholder="IBAN (optioneel)" value={iban} onChange={(e) => setIban(e.target.value)} />
      <Button onClick={() => run(() => { store.createExternal({ name, ibans: iban ? [iban] : [] }, actor); setName(""); setIban(""); }, "Toegevoegd")}>Toevoegen</Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contribution
// ---------------------------------------------------------------------------

export function ContributionPage() {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const canEdit = useCan("edit");
  const run = useAction();
  const fy = currentFiscalYear(state, today());
  const [month, setMonth] = useState(firstOfMonth(today()).slice(0, 7));
  const months: LocalDate[] = [];
  if (fy) for (let m = fy.startDate; m <= fy.endDate && m <= today(); m = addMonths(m, 1)) months.push(m);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Contributie" description="Per maand, per soort lid. Op de 1e van de maand komt het bedrag op ieders rekening. Twee keer boeken kan niet." />
      <ReadOnlyNotice />
      {canEdit && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-5">
            <Field label="Maand"><Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-44" /></Field>
            <Button onClick={() => run(() => {
              const n = store.chargeContributions(localDate(`${month}-01`), actor);
              if (n === 0) throw new Error("Voor deze maand is de contributie al geboekt (of er zijn geen betalende leden)");
              return n;
            }, "Contributie geboekt")}>Contributie boeken</Button>
            <span className="pb-2 text-sm text-muted-foreground">In de echte versie gebeurt dit automatisch op de 1e.</span>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle>Dit boekjaar</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Maand</TableHead><TableHead className="text-right">Leden</TableHead><TableHead className="text-right">Totaal</TableHead></TableRow></TableHeader>
            <TableBody>
              {months.reverse().map((m) => {
                const rows = state.contributionMonths.filter((c) => c.month === m);
                const total = sum(rows.map((r) => state.entries.find((e) => e.id === r.entryId)!.lines[0].amount));
                return (
                  <TableRow key={m}>
                    <TableCell>{formatMonthNl(m)}</TableCell>
                    <TableCell className="text-right">{rows.length || <Badge variant="warning">nog niet geboekt</Badge>}</TableCell>
                    <TableCell className="text-right">{rows.length > 0 && <Money value={total} />}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

export function useLineTarget() {
  const { state, d } = useLedger();
  return (l: Parameters<typeof lineTarget>[2]) => lineTarget(state, d, l);
}
