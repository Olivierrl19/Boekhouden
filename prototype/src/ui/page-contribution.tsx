import { useMemo, useState } from "react";
import { Check, CircleDashed, X, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { allocate, cents, formatEuro, sum } from "@/domain/money";
import { firstOfMonth, formatDateNl, formatMonthNl, localDate } from "@/domain/dates";
import { contributionOverview, currentFiscalYear, today, type FiscalYear } from "../ledger";
import { A, Empty, PageHeader, ReadOnlyNotice, Select, useAction, useApp, useCan, useLedger } from "./core";

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
                    <span className="ml-2 text-xs text-muted-foreground">{state.memberTypes.find((t) => t.id === r.party.member?.memberTypeId)?.name}</span>
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
                <TableRow key={c.t.id}>
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verdeling van de contributie over de potjes</CardTitle>
        <CardDescription>Contributie is inkomsten voor het dispuut. Met deze verdeelsleutel komt elk opgelegd bedrag automatisch als inkomsten in de potjes (tot op de cent). Wijzigen geldt vanaf de volgende maand die je oplegt.</CardDescription>
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
                    const idx = parsed.findIndex((k) => k.potId === p.id);
                    const parts = total ? allocate(t.monthly, parsed.map((k) => k.weight)) : [];
                    return <TableCell key={t.id} className="text-right">{idx >= 0 && <Money value={parts[idx]} />}</TableCell>;
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
              {types.map((t) => <TableCell key={t.id} className="text-right"><Money value={total ? t.monthly : cents(0)} /></TableCell>)}
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
