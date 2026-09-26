import { useMemo, useState } from "react";
import { Check, CircleDashed, X, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { formatEuro, sum, type Cents } from "@/domain/money";
import { addMonths, firstOfMonth, formatDateNl, formatMonthNl, localDate, type LocalDate } from "@/domain/dates";
import { contributionMonthsForPot, contributionOverview, contributionSplit, currentFiscalYear, plannedType, resultByPot, today, type FiscalYear } from "../ledger";
import { A, Empty, Field, PageHeader, ReadOnlyNotice, Select, isControl, parseAmount, useAction, useApp, useCan, useLedger } from "./core";

const MONTH_SHORT = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];

export function ContributionPage() {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const canEdit = useCan("edit");
  const run = useAction();
  const years = [...state.fiscalYears].sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  const [fyId, setFyId] = useState<string | null>(null);
  const fy: FiscalYear | null = years.find((y) => y.id === fyId) ?? currentFiscalYear(state, today());
  const [month, setMonth] = useState(firstOfMonth(today()).slice(0, 7));
  const [filter, setFilter] = useState<"all" | "behind">("all");
  const overview = fy ? contributionOverview(state, fy) : null;
  if (!fy || !overview) return <Empty>Geen boekjaar.</Empty>;
  const shownMonths = overview.months.filter((m) => m <= today());
  const rows = overview.rows.filter((r) => filter === "all" || r.open > 0);
  const totals = {
    charged: sum(overview.rows.map((r) => r.charged)),
    open: sum(overview.rows.map((r) => r.open)),
    advance: sum(overview.rows.map((r) => r.advance)),
    behind: overview.rows.filter((r) => r.open > 0).length,
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Contributie" description="Leden maken hun contributie elke maand zelf over. Hier zie je per maand wie betaald heeft, wijs je betalingen toe en bepaal je hoe de contributie over de potjes wordt verdeeld.">
        <Select value={fy.id} onChange={(e) => setFyId(e.target.value)} className="w-44">
          {years.map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}
        </Select>
      </PageHeader>
      <ReadOnlyNotice />

      <div className="grid gap-4 sm:grid-cols-4">
        <Card><CardHeader><CardDescription>Opgelegd dit boekjaar</CardDescription><CardTitle className="text-xl"><Money value={totals.charged} /></CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Nog te ontvangen</CardDescription><CardTitle className="text-xl text-red-700 dark:text-red-400"><Money value={totals.open} /></CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Leden met achterstand</CardDescription><CardTitle className="text-xl">{totals.behind}</CardTitle></CardHeader></Card>
        <Card><CardHeader><CardDescription>Vooruitbetaald</CardDescription><CardTitle className="text-xl"><Money value={totals.advance} /></CardTitle></CardHeader></Card>
      </div>

      {canEdit && <BulkAssign />}

      <Card>
        <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
          <div>
            <CardTitle>Wie heeft betaald?</CardTitle>
            <CardDescription>Betalingen worden eerst met de oudste maand verrekend. <Check className="inline size-3 text-emerald-600" /> betaald · <CircleDashed className="inline size-3 text-amber-600" /> deels · <X className="inline size-3 text-red-600" /> open · <Minus className="inline size-3 text-muted-foreground" /> geen contributie</CardDescription>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Select value={filter} onChange={(e) => setFilter(e.target.value as "all" | "behind")} className="w-48">
              <option value="all">Alle leden</option>
              <option value="behind">Alleen met achterstand</option>
            </Select>
            {canEdit && (
              <>
                <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-40" />
                <Button onClick={() => run(() => {
                  const n = store.chargeContributions(localDate(`${month}-01`), actor);
                  if (n === 0) throw new Error("Voor deze maand is de contributie al opgelegd (of er zijn geen betalende leden)");
                }, "Contributie opgelegd")}>Contributie opleggen</Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-card">Lid</TableHead>
                {shownMonths.map((m) => <TableHead key={m} className="px-1 text-center">{MONTH_SHORT[Number(m.slice(5, 7)) - 1]}</TableHead>)}
                <TableHead className="text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.party.id}>
                  <TableCell className="sticky left-0 bg-card whitespace-nowrap">
                    <A to={`persoon/${r.party.id}`}>{r.party.name}</A>
                    <span className="ml-2 text-xs text-muted-foreground">{plannedType(state, r.party, today())?.name ?? "afwezig"}</span>
                  </TableCell>
                  {shownMonths.map((m) => {
                    const c = r.months.get(m);
                    const title = c ? `${formatMonthNl(m)}: ${formatEuro(c.covered)} van ${formatEuro(c.charged)} betaald` : `${formatMonthNl(m)}: geen contributie`;
                    return (
                      <TableCell key={m} className="px-1 text-center" title={title}>
                        {!c ? <Minus className="mx-auto size-4 text-muted-foreground/40" /> : c.status === "paid" ? <Check className="mx-auto size-4 text-emerald-600" /> : c.status === "partial" ? <CircleDashed className="mx-auto size-4 text-amber-600" /> : <X className="mx-auto size-4 text-red-600" />}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right whitespace-nowrap">
                    {r.open > 0 ? <Money value={r.open} className="text-red-700 dark:text-red-400" /> : r.advance > 0 ? <span className="text-xs text-emerald-700">+{formatEuro(r.advance)} vooruit</span> : <Check className="ml-auto size-4 text-emerald-600" />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Planning fy={fy} />

      <SurplusReturn fy={fy} />

      <ContributionKey />
    </div>
  );
}

/** Incoming bank lines that look like contribution: confirm them all at once. */
function BulkAssign() {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const run = useAction();
  const members = state.parties.filter((p) => p.kind === "member").sort((a, b) => a.name.localeCompare(b.name));
  const candidates = useMemo(() => {
    return d.unassigned
      .filter((t) => t.amount > 0)
      .map((t) => {
        const sg = store.suggestions(t.id).find((x) => x.target.kind === "contribution" || (x.target.kind === "person" && d.partyById.get(x.target.partyId)?.kind === "member"));
        const partyId = sg && "partyId" in sg.target ? sg.target.partyId : "";
        const likely = sg?.target.kind === "contribution" || /contributie/i.test(t.description);
        return { t, partyId, likely };
      })
      .filter((c) => c.partyId || /contributie/i.test(c.t.description));
  }, [d, store]);
  const [choice, setChoice] = useState<Record<string, { on: boolean; partyId: string }>>({});
  if (!candidates.length) return null;
  const get = (id: string, fallback: { partyId: string; likely: boolean }) => choice[id] ?? { on: fallback.likely && !!fallback.partyId, partyId: fallback.partyId };
  const selected = candidates.filter((c) => get(c.t.id, c).on && get(c.t.id, c).partyId);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contributiebetalingen toewijzen ({candidates.length})</CardTitle>
        <CardDescription>Binnengekomen bedragen van leden die nog niet zijn toegewezen. Controleer het lid, vink aan en boek alles in één keer als contributie.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 p-0">
        <Table>
          <TableHeader><TableRow><TableHead className="w-8" /><TableHead>Datum</TableHead><TableHead>Van</TableHead><TableHead className="text-right">Bedrag</TableHead><TableHead>Contributie van</TableHead></TableRow></TableHeader>
          <TableBody>
            {candidates.map((c) => {
              const v = get(c.t.id, c);
              return (
                <TableRow key={c.t.id} className="cursor-pointer" onClick={(e) => { if (!isControl(e.target)) setChoice({ ...choice, [c.t.id]: { ...v, on: !v.on } }); }}>
                  <TableCell><input type="checkbox" checked={v.on} onChange={(e) => setChoice({ ...choice, [c.t.id]: { ...v, on: e.target.checked } })} /></TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateNl(c.t.bookingDate)}</TableCell>
                  <TableCell><div>{c.t.counterpartyName}</div><div className="text-xs text-muted-foreground">{c.t.description}</div></TableCell>
                  <TableCell className="text-right"><Money value={c.t.amount} /></TableCell>
                  <TableCell>
                    <Select value={v.partyId} onChange={(e) => setChoice({ ...choice, [c.t.id]: { on: true, partyId: e.target.value } })}>
                      <option value="">Kies een lid…</option>
                      {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </Select>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between px-5 pb-5">
          <span className="text-sm text-muted-foreground">{selected.length} geselecteerd · {formatEuro(sum(selected.map((c) => c.t.amount)))}</span>
          <Button disabled={!selected.length} onClick={() => run(() => {
            store.assignMany(selected.map((c) => ({ txId: c.t.id, part: { kind: "contribution", id: get(c.t.id, c).partyId, amount: c.t.amount } })), actor);
            setChoice({});
          }, "Contributiebetalingen geboekt")}>Boek als contributie</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ContributionKey() {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const [weights, setWeights] = useState<Record<string, string>>(() => Object.fromEntries(state.settings.contributionKey.map((k) => [k.potId, String(k.weight)])));
  const parsed = state.pots.map((p) => ({ potId: p.id, weight: Number(weights[p.id] || 0) })).filter((k) => k.weight > 0);
  const total = parsed.reduce((s, k) => s + k.weight, 0);
  const types = state.memberTypes.filter((t) => t.monthly > 0);
  // Preview with the key as currently typed (not yet saved).
  const typeSplit = (typeId: string): Map<string, Cents> => {
    const t = types.find((x) => x.id === typeId)!;
    try {
      const preview = { ...state, settings: { ...state.settings, contributionKey: parsed } };
      return new Map(contributionSplit(preview, t).map((x) => [x.potId, x.amount]));
    } catch {
      return new Map();
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verdeling van de contributie over de potjes</CardTitle>
        <CardDescription>Contributie is inkomsten voor het dispuut. Vaste delen per soort lid (zoals woonkamer en bier) stel je in bij Leden → Soorten leden; wat overblijft gaat naar het rest-potje van die soort of wordt met deze verdeelsleutel verdeeld. De kolommen rechts tonen per soort lid waar elke euro heen gaat. Wijzigen geldt vanaf de volgende maand die je oplegt.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Potje</TableHead>
              <TableHead className="w-32">Aandeel</TableHead>
              <TableHead className="text-right">%</TableHead>
              {types.map((t) => <TableHead key={t.id} className="text-right">{t.name} ({formatEuro(t.monthly)})</TableHead>)}
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.pots.map((p) => {
              const w = Number(weights[p.id] || 0);
              return (
                <TableRow key={p.id} className={w ? "" : "text-muted-foreground"}>
                  <TableCell>{p.name}</TableCell>
                  <TableCell>{isAdmin ? <Input value={weights[p.id] ?? ""} onChange={(e) => setWeights({ ...weights, [p.id]: e.target.value.replace(/\D/g, "") })} className="h-8 w-20" placeholder="0" /> : w || ""}</TableCell>
                  <TableCell className="text-right">{total && w ? `${((w / total) * 100).toFixed(0)}%` : ""}</TableCell>
                  {types.map((t) => {
                    const amount = typeSplit(t.id).get(p.id);
                    return <TableCell key={t.id} className="text-right">{amount ? <Money value={amount} /> : null}</TableCell>;
                  })}
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Totaal</TableCell>
              <TableCell>{total}</TableCell>
              <TableCell className="text-right">{total ? "100%" : ""}</TableCell>
              {types.map((t) => <TableCell key={t.id} className="text-right"><Money value={sum([...typeSplit(t.id).values()])} /></TableCell>)}
            </TableRow>
          </TableFooter>
        </Table>
        {isAdmin && (
          <div className="p-5">
            <Button onClick={() => run(() => store.setContributionKey(parsed, actor), "Verdeling opgeslagen")}>Verdeling opslaan</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Member type per member per month, like the "Contributie & ledenplanning" sheet. */
function Planning({ fy }: { fy: FiscalYear }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const [onwards, setOnwards] = useState(true);
  const [open, setOpen] = useState(false);
  const months: LocalDate[] = [];
  for (let m = fy.startDate; m <= fy.endDate; m = addMonths(m, 1)) months.push(m);
  const members = state.parties
    .filter((p) => p.member && (p.active || state.memberPlanning.some((c) => c.memberId === p.id && c.month >= fy.startDate && c.month <= fy.endDate)))
    .sort((a, b) => (a.member!.joinedOn < b.member!.joinedOn ? -1 : a.member!.joinedOn > b.member!.joinedOn ? 1 : a.name.localeCompare(b.name)));
  const charged = new Set(state.contributionMonths.map((c) => `${c.memberId}|${c.month}`));
  const counts = months.map((m) => {
    const byType = new Map<string, number>();
    for (const p of members) {
      const t = plannedType(state, p, m);
      if (t) byType.set(t.id, (byType.get(t.id) ?? 0) + 1);
    }
    return byType;
  });
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
        <div>
          <CardTitle>Ledenplanning {fy.label}</CardTitle>
          <CardDescription>Per lid per maand: jongerejaars, buitenland, ouderejaars, nieuwe lichting of afwezig. Bij het opleggen van de contributie telt de planning; al opgelegde maanden liggen vast (grijs).</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setOpen((v) => !v)}>{open ? "Verbergen" : "Planning tonen"}</Button>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-3 p-0">
          {isAdmin && (
            <label className="flex items-center gap-2 px-5 text-sm">
              <input type="checkbox" checked={onwards} onChange={(e) => setOnwards(e.target.checked)} /> Een wijziging geldt ook voor de maanden erna (t/m {formatMonthNl(fy.endDate)})
            </label>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-card">Lid</TableHead>
                {months.map((m) => <TableHead key={m} className="px-1 text-center">{MONTH_SHORT[Number(m.slice(5, 7)) - 1]}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="sticky left-0 bg-card whitespace-nowrap"><A to={`persoon/${p.id}`}>{p.name}</A></TableCell>
                  {months.map((m) => {
                    const t = plannedType(state, p, m);
                    const locked = charged.has(`${p.id}|${m}`) || !isAdmin;
                    return (
                      <TableCell key={m} className="px-0.5">
                        {locked ? (
                          <span className={`block rounded px-1 text-center text-xs ${charged.has(`${p.id}|${m}`) ? "bg-muted" : ""}`}>{t ? shortName(t.name) : "—"}</span>
                        ) : (
                          <select
                            aria-label={`${p.name} ${formatMonthNl(m)}`}
                            className="w-full rounded border border-input bg-background px-0.5 py-0.5 text-xs"
                            value={t?.id ?? "none"}
                            onChange={(e) => run(() => store.setPlanning({ memberId: p.id, fromMonth: m, toMonth: onwards ? fy.endDate : m, memberTypeId: e.target.value === "none" ? null : e.target.value }, actor))}
                          >
                            {state.memberTypes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                            <option value="none">Afwezig</option>
                          </select>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              {state.memberTypes.filter((t) => counts.some((c) => c.has(t.id))).map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="sticky left-0 bg-muted whitespace-nowrap">Aantal {t.name.toLowerCase()}</TableCell>
                  {counts.map((c, i) => <TableCell key={i} className="px-1 text-center">{c.get(t.id) ?? 0}</TableCell>)}
                </TableRow>
              ))}
            </TableFooter>
          </Table>
        </CardContent>
      )}
    </Card>
  );
}

function shortName(name: string) {
  return name.length <= 6 ? name : name.slice(0, 5) + "…";
}

/** "Geld terug bier": return a pot's surplus to members, pro rata to the months they paid for it. */
function SurplusReturn({ fy }: { fy: FiscalYear }) {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const canApprove = useCan("approve");
  const run = useAction();
  const splitPots = [...new Set(state.memberTypes.flatMap((t) => (t.split ?? []).map((p) => p.potId)))];
  const [potId, setPotId] = useState(splitPots[0] ?? state.pots[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState<string>(today() > fy.endDate ? fy.endDate : today());
  const [off, setOff] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  if (!canApprove || !splitPots.length) return null;
  const months = contributionMonthsForPot(state, fy, potId);
  const r = resultByPot(state, fy).get(potId);
  const surplus = r ? r.income - r.expense : 0;
  const rows = [...months].map(([partyId, n]) => ({ party: d.partyById.get(partyId)!, n })).sort((a, b) => a.party.name.localeCompare(b.party.name));
  const shares = rows.filter((x) => !off.has(x.party.id)).map((x) => ({ partyId: x.party.id, weight: x.n }));
  const totalMonths = shares.reduce((s, x) => s + x.weight, 0);
  let perMonth = "";
  try {
    if (amount.trim() && totalMonths) perMonth = formatEuro(Math.round(parseAmount(amount) / totalMonths) as Cents);
  } catch {
    perMonth = "";
  }
  const potName = d.potById.get(potId)?.name ?? "";
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
        <div>
          <CardTitle>Overschot teruggeven aan leden</CardTitle>
          <CardDescription>Bijvoorbeeld “geld terug bier”: wat er van het bierdeel van de contributie over is, gaat terug op de ledenrekening, naar rato van het aantal maanden dat iemand ervoor betaald heeft.</CardDescription>
        </div>
        <Button variant="outline" onClick={() => setOpen((v) => !v)}>{open ? "Verbergen" : "Openen"}</Button>
      </CardHeader>
      {open && (
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Potje"><Select value={potId} onChange={(e) => { setPotId(e.target.value); setOff(new Set()); }}>{splitPots.map((id) => <option key={id} value={id}>{d.potById.get(id)?.name}</option>)}</Select></Field>
            <div className="text-sm"><div className="text-muted-foreground">Saldo {potName} {fy.label}</div><Money value={surplus} className="font-medium" /></div>
            <Field label="Terug te geven" hint={perMonth && `${perMonth} per maand`}><Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={surplus > 0 ? (surplus / 100).toFixed(2).replace(".", ",") : "0,00"} /></Field>
            <Field label="Datum"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          </div>
          {rows.length === 0 ? <Empty>In {fy.label} is nog geen contributie met een deel voor {potName} opgelegd.</Empty> : (
            <Table>
              <TableHeader><TableRow><TableHead className="w-8" /><TableHead>Lid</TableHead><TableHead className="text-right">Maanden betaald</TableHead></TableRow></TableHeader>
              <TableBody>
                {rows.map((x) => {
                  const on = !off.has(x.party.id);
                  const toggle = () => setOff((prev) => { const n = new Set(prev); if (n.has(x.party.id)) n.delete(x.party.id); else n.add(x.party.id); return n; });
                  return (
                    <TableRow key={x.party.id} className="cursor-pointer" onClick={(e) => { if (!isControl(e.target)) toggle(); }}>
                      <TableCell><input type="checkbox" checked={on} onChange={toggle} aria-label={x.party.name} /></TableCell>
                      <TableCell>{x.party.name}</TableCell>
                      <TableCell className="text-right">{x.n}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <div>
            <Button disabled={!shares.length || !amount.trim()} onClick={() => run(() => {
              const total = parseAmount(amount);
              if (!window.confirm(`${formatEuro(total)} uit ${potName} verdelen over ${shares.length} leden (${totalMonths} maanden)?`)) return;
              store.returnPotSurplus({ potId, date: localDate(date), amount: total, shares, description: `Geld terug ${potName.toLowerCase()} ${fy.label}` }, actor);
              setAmount("");
            }, "Teruggegeven op de ledenrekeningen")}>Teruggeven op de ledenrekeningen</Button>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
