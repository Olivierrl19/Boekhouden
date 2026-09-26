import { useMemo, useState } from "react";
import { PartyPopper, Plus, Printer, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { cents, formatEuro, sum, type Cents } from "@/domain/money";
import { formatDateNl, localDate } from "@/domain/dates";
import type { SettlementShareInput, ShareMethod } from "@/domain/ledger/templates";
import { today } from "../ledger";
import { A, Empty, Field, PageHeader, ReadOnlyNotice, Select, parseAmount, useAction, useApp, useCan, useLedger } from "./core";
import { lineTarget } from "./labels";

export function ActivitiesPage() {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const canEdit = useCan("edit");
  const run = useAction();
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [potId, setPotId] = useState(state.pots.find((p) => p.code === "ACTIVITEITEN")?.id ?? "");
  const [q, setQ] = useState("");
  const match = (a: { number: string; name: string }) => !q || `${a.number} ${a.name}`.toLowerCase().includes(q.toLowerCase());
  const open = state.activities.filter((a) => a.status === "open" && match(a));
  const settled = state.activities.filter((a) => a.status === "settled" && match(a)).slice().reverse();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activiteiten" description="Alles wat je voor een activiteit uitgeeft of ontvangt staat op 'nog te verdelen'. Bij het afrekenen verdeel je het over de deelnemers. Elke activiteit krijgt een vast nummer (A26-001), handig als betaalomschrijving.">
        <Input placeholder="Zoek op nummer of naam…" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
      </PageHeader>
      <ReadOnlyNotice />
      {canEdit && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><PartyPopper className="size-5" /> Nieuwe activiteit</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Naam"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Lustrumgala" /></Field>
            <Field label="Datum"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Potje (voor het deel dat het dispuut zelf betaalt)"><Select value={potId} onChange={(e) => setPotId(e.target.value)}>{state.pots.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Button onClick={() => run(() => { store.createActivity({ name, heldOn: date ? localDate(date) : null, potId }, actor); setName(""); setDate(""); }, "Activiteit aangemaakt")}><Plus /> Aanmaken</Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle>Open</CardTitle></CardHeader>
        <CardContent className="p-0">
          {open.length === 0 ? <Empty>Geen open activiteiten.</Empty> : (
            <Table>
              <TableHeader><TableRow><TableHead>Nr.</TableHead><TableHead>Activiteit</TableHead><TableHead>Datum</TableHead><TableHead>Potje</TableHead><TableHead className="text-right">Nog te verdelen</TableHead></TableRow></TableHeader>
              <TableBody>
                {open.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono text-xs">{a.number}</TableCell>
                    <TableCell><A to={`activiteit/${a.id}`}>{a.name}</A></TableCell>
                    <TableCell>{a.heldOn ? formatDateNl(a.heldOn) : "—"}</TableCell>
                    <TableCell>{d.potById.get(a.potId)?.name}</TableCell>
                    <TableCell className="text-right"><Money value={d.activityBalance.get(a.id) ?? 0} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Afgerekend</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableBody>
              {settled.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-xs">{a.number}</TableCell>
                  <TableCell><A to={`activiteit/${a.id}`}>{a.name}</A></TableCell>
                  <TableCell>{a.heldOn ? formatDateNl(a.heldOn) : "—"}</TableCell>
                  <TableCell>{d.potById.get(a.potId)?.name}</TableCell>
                  <TableCell className="text-right"><Badge variant="success">afgerekend</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

interface ShareRow { partyId: string | null; include: boolean; method: ShareMethod; weight: string; fixed: string }

export function ActivityPage({ id }: { id: string }) {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const canEdit = useCan("edit");
  const canApprove = useCan("approve");
  const run = useAction();
  const act = state.activities.find((a) => a.id === id);
  const lines = useMemo(
    () => state.entries.flatMap((e) => e.lines.filter((l) => l.activityId === id).map((l) => ({ e, l }))),
    [state, id],
  );
  const [charge, setCharge] = useState({ partyId: "", amount: "", description: "" });
  if (!act) return <Empty>Activiteit niet gevonden.</Empty>;
  const balance = d.activityBalance.get(act.id) ?? cents(0);
  const toDistribute = d.accountByKey.get("TO_DISTRIBUTE")!.id;
  const bookings = lines.filter(({ l }) => l.accountId === toDistribute && act.status === "open" ? true : l.accountId === toDistribute && lines.length > 0);
  const settlementLines = act.settlementEntryId ? d.entryById.get(act.settlementEntryId)?.lines.filter((l) => l.accountId !== toDistribute) ?? [] : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={`${act.number} · ${act.name}`} description={<>{act.heldOn ? formatDateNl(act.heldOn) : "Geen datum"} · potje {d.potById.get(act.potId)?.name} · {act.status === "open" ? <Badge variant="warning">open</Badge> : <Badge variant="success">afgerekend</Badge>}</>}>
        <Button variant="outline" onClick={() => window.print()}><Printer /> Afdrukken / PDF</Button>
        {act.status === "settled" && canApprove && (
          <Button variant="outline" onClick={() => { const r = window.prompt("Waarom heropen je deze activiteit? De afrekening wordt tegengeboekt."); if (r) run(() => store.reopenActivity(act.id, r, actor), "Activiteit heropend"); }}><RotateCcw /> Heropenen</Button>
        )}
      </PageHeader>
      <ReadOnlyNotice />
      <Card>
        <CardHeader><CardTitle>Kosten en ontvangsten</CardTitle><CardDescription>Uitgaven (bank, declaraties) verhogen het te verdelen bedrag, ontvangsten verlagen het.</CardDescription></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Datum</TableHead><TableHead>Omschrijving</TableHead><TableHead className="text-right">Kosten</TableHead><TableHead className="text-right">Ontvangen</TableHead></TableRow></TableHeader>
            <TableBody>
              {bookings.filter(({ e }) => e.template !== "T11").map(({ e, l }, i) => (
                <TableRow key={i}>
                  <TableCell className="whitespace-nowrap">{formatDateNl(e.date)}</TableCell>
                  <TableCell>{e.description}{e.reversesEntryId && <Badge variant="warning" className="ml-2">correctie</Badge>}</TableCell>
                  <TableCell className="text-right">{l.amount > 0 && <Money value={l.amount} />}</TableCell>
                  <TableCell className="text-right">{l.amount < 0 && <Money value={-l.amount} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter><TableRow><TableCell colSpan={2}>{act.status === "open" ? "Nog te verdelen" : "Verdeeld"}</TableCell><TableCell className="text-right" colSpan={2}><Money value={act.status === "open" ? balance : sum(settlementLines.map((l) => l.amount))} /></TableCell></TableRow></TableFooter>
          </Table>
        </CardContent>
      </Card>

      {act.status === "open" && canEdit && (
        <Card className="print:hidden">
          <CardHeader><CardTitle>Iets op iemands rekening zetten</CardTitle><CardDescription>Bijv. een los kaartje, of iemand die iets voor de activiteit betaalde (negatief bedrag = tegoed).</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Persoon"><Select value={charge.partyId} onChange={(e) => setCharge({ ...charge, partyId: e.target.value })}><option value="">Kies…</option>{state.parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
            <Field label="Bedrag" hint="Negatief = tegoed voor die persoon"><Input value={charge.amount} onChange={(e) => setCharge({ ...charge, amount: e.target.value })} placeholder="12,50" /></Field>
            <Field label="Omschrijving"><Input value={charge.description} onChange={(e) => setCharge({ ...charge, description: e.target.value })} /></Field>
            <Button variant="outline" onClick={() => run(() => { store.chargePerson({ partyId: charge.partyId, date: today(), amount: parseAmount(charge.amount), target: { kind: "activity", id: act.id }, description: charge.description }, actor); setCharge({ partyId: "", amount: "", description: "" }); }, "Geboekt")}>Boeken</Button>
          </CardContent>
        </Card>
      )}

      {act.status === "open" ? <SettlementForm activityId={act.id} balance={balance} /> : (
        <Card>
          <CardHeader><CardTitle>Afrekening</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader><TableRow><TableHead>Deelnemer</TableHead><TableHead className="text-right">Bedrag</TableHead></TableRow></TableHeader>
              <TableBody>
                {settlementLines.map((l, i) => (
                  <TableRow key={i}><TableCell>{l.partyId ? lineTarget(state, d, l) : `Dispuut (potje ${d.potById.get(l.potId ?? "")?.name})`}</TableCell><TableCell className="text-right"><Money value={l.amount} /></TableCell></TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SettlementForm({ activityId, balance }: { activityId: string; balance: Cents }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const canApprove = useCan("approve");
  const run = useAction();
  const people = state.parties.filter((p) => p.active).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "member" ? -1 : 1));
  const [rows, setRows] = useState<ShareRow[]>(() => [
    { partyId: null, include: false, method: "fixed", weight: "1", fixed: "" },
    ...people.map((p) => ({ partyId: p.id, include: false, method: (p.kind === "external" ? "fixed" : "equal") as ShareMethod, weight: "1", fixed: "" })),
  ]);
  const [filter, setFilter] = useState("");
  const [newExternal, setNewExternal] = useState({ name: "", amount: "" });
  const update = (i: number, patch: Partial<ShareRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  let shares: SettlementShareInput[] = [];
  let preview: { amounts: Map<string, Cents>; error: string | null } = { amounts: new Map(), error: null };
  try {
    shares = rows.filter((r) => r.include).map((r) => {
      const party = r.partyId ? state.parties.find((p) => p.id === r.partyId) : null;
      return {
        partyId: r.partyId,
        partyKind: party?.kind,
        method: r.method,
        weight: r.method === "weight" ? Number(r.weight || 0) : undefined,
        fixedAmount: r.method === "fixed" ? parseAmount(r.fixed) : undefined,
      };
    });
    const { allocations } = store.previewSettlement(activityId, shares);
    preview = { amounts: new Map(allocations.map((a) => [a.partyId ?? "__dispuut__", a.amount])), error: null };
  } catch (err) {
    preview = { amounts: new Map(), error: (err as Error).message };
  }
  const chosen = rows.filter((r) => r.include).length;
  const [date, setDate] = useState<string>(today());

  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle>Afrekenen: <Money value={balance} /> verdelen</CardTitle>
        <CardDescription>Vink aan wie meedeed. Gelijk verdelen, naar streepjes (gewicht), of een vast bedrag (bijv. voor een ander dispuut, dat regelt het onderling). De verdeling klopt altijd tot op de cent.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Zoek naam…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48" />
          <Button variant="outline" size="sm" onClick={() => setRows(rows.map((r) => { const p = state.parties.find((x) => x.id === r.partyId); return p?.kind === "member" ? { ...r, include: true } : r; }))}>Alle leden</Button>
          <Button variant="outline" size="sm" onClick={() => setRows(rows.map((r) => ({ ...r, include: false })))}>Niemand</Button>
        </div>
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3 text-sm">
          <span className="w-full text-muted-foreground">Deed er een ander dispuut of een gast mee die nog niet in de lijst staat? Voeg toe met een vast bedrag:</span>
          <Input placeholder="Naam, bijv. Dispuut Bacchus" value={newExternal.name} onChange={(e) => setNewExternal({ ...newExternal, name: e.target.value })} className="w-56" />
          <Input placeholder="Bedrag" value={newExternal.amount} onChange={(e) => setNewExternal({ ...newExternal, amount: e.target.value })} className="w-28" />
          <Button size="sm" variant="outline" onClick={() => run(() => {
            if (newExternal.amount) parseAmount(newExternal.amount);
            const p = store.createExternal({ name: newExternal.name }, actor);
            setRows([...rows, { partyId: p.id, include: true, method: "fixed", weight: "1", fixed: newExternal.amount }]);
            setNewExternal({ name: "", amount: "" });
          }, "Externe toegevoegd")}>Toevoegen</Button>
        </div>
        <div className="max-h-[28rem] overflow-y-auto rounded-md border">
          <Table>
            <TableHeader><TableRow><TableHead className="w-8" /><TableHead>Deelnemer</TableHead><TableHead>Methode</TableHead><TableHead>Waarde</TableHead><TableHead className="text-right">Betaalt</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((r, i) => {
                const party = r.partyId ? state.parties.find((p) => p.id === r.partyId) : null;
                const label = party ? party.name : "Dispuut zelf (uit het potje)";
                if (filter && !label.toLowerCase().includes(filter.toLowerCase())) return null;
                const amount = preview.amounts.get(r.partyId ?? "__dispuut__");
                return (
                  <TableRow key={r.partyId ?? "dispuut"} className={r.include ? "" : "opacity-60"}>
                    <TableCell><input type="checkbox" checked={r.include} onChange={(e) => update(i, { include: e.target.checked })} /></TableCell>
                    <TableCell>{label}{party?.kind === "external" && <Badge variant="outline" className="ml-2">extern</Badge>}</TableCell>
                    <TableCell>
                      <Select value={r.method} onChange={(e) => update(i, { method: e.target.value as ShareMethod, include: true })} className="w-32">
                        <option value="equal">Gelijk</option><option value="weight">Streepjes</option><option value="fixed">Vast bedrag</option>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {r.method === "weight" && <Input value={r.weight} onChange={(e) => update(i, { weight: e.target.value.replace(/\D/g, ""), include: true })} className="w-20" inputMode="numeric" />}
                      {r.method === "fixed" && <Input value={r.fixed} onChange={(e) => update(i, { fixed: e.target.value, include: true })} className="w-24" placeholder="0,00" />}
                    </TableCell>
                    <TableCell className="text-right">{r.include && amount !== undefined && <Money value={amount} />}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="text-sm">
            {preview.error ? <span className="text-red-600">{chosen === 0 ? "Kies wie meedeed." : preview.error}</span> : <span className="text-emerald-700">{chosen} deelnemers · totaal {formatEuro(sum([...preview.amounts.values()]))} = te verdelen bedrag</span>}
          </div>
          <div className="flex items-end gap-2">
            <Field label="Datum afrekening"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            {canApprove ? (
              <Button disabled={!!preview.error} onClick={() => run(() => store.settleActivity({ activityId, date: localDate(date), shares, expectedBalance: balance }, actor), "Afgerekend: bedragen staan op ieders rekening")}>Afrekenen</Button>
            ) : <span className="pb-2 text-sm text-muted-foreground">De fiscus rekent definitief af.</span>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
