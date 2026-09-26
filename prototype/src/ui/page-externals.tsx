import { useState } from "react";
import { Copy, Mail, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { cents, formatEuro, sum } from "@/domain/money";
import { formatIban } from "@/domain/bank/iban";
import { today, type Party, type State } from "../ledger";
import { A, Empty, Field, PageHeader, ReadOnlyNotice, parseAmount, useAction, useApp, useCan, useLedger } from "./core";
import { statementLines } from "./page-people";

/** Payment request text for an external (to paste into Tikkie, WhatsApp or a mail). */
export function paymentRequestText(state: State, party: Party, balance: number): string {
  const open = statementLines(state, party.id).filter((r) => r.amount > 0).slice(-5);
  return [
    `Hoi ${party.name},`,
    "",
    `Van ${state.settings.name} staat er nog ${formatEuro(cents(balance))} open:`,
    ...open.map((r) => `- ${r.description}${r.activity ? ` (${r.activity})` : ""}: ${formatEuro(cents(r.amount))}`),
    "",
    `Wil je dit overmaken naar ${formatIban(state.settings.paymentIban)} t.n.v. ${state.settings.paymentAccountName}, o.v.v. "${party.name}"? Een Tikkie mag ook.`,
    "",
    "Dank je!",
  ].join("\n");
}

export function ExternalsPage() {
  const { store, actor, notify } = useApp();
  const { state, d } = useLedger();
  const canEdit = useCan("edit");
  const run = useAction();
  const [f, setF] = useState({ name: "", email: "", iban: "" });
  const [charge, setCharge] = useState<{ partyId: string; amount: string; description: string; target: string } | null>(null);
  const externals = state.parties.filter((p) => p.kind === "external").sort((a, b) => (d.partyBalance.get(b.id) ?? 0) - (d.partyBalance.get(a.id) ?? 0));
  const openActs = state.activities.filter((a) => a.status === "open");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Externen" description="Andere disputen, sponsoren, leveranciers en gasten. Ze hebben een eigen rekening, net als leden. Voor een ander dispuut zet je één bedrag op hun rekening; zij regelen onderling de verdeling." />
      <ReadOnlyNotice />
      {canEdit && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Plus className="size-5" /> Externe toevoegen</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Naam"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Dispuut Bacchus" /></Field>
            <Field label="E-mail (optioneel)"><Input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label="IBAN (optioneel)" hint="Dan herkent de app hun betalingen"><Input value={f.iban} onChange={(e) => setF({ ...f, iban: e.target.value })} placeholder="NL.." /></Field>
            <Button onClick={() => run(() => { store.createExternal({ name: f.name, email: f.email, ibans: f.iban ? [f.iban] : [] }, actor); setF({ name: "", email: "", iban: "" }); }, "Externe toegevoegd")}>Toevoegen</Button>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="p-0">
          {externals.length === 0 ? <Empty>Nog geen externen.</Empty> : (
            <Table>
              <TableHeader><TableRow><TableHead>Naam</TableHead><TableHead>Contact</TableHead><TableHead className="text-right">Saldo</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {externals.map((x) => {
                  const balance = d.partyBalance.get(x.id) ?? 0;
                  const text = paymentRequestText(state, x, balance);
                  return (
                    <TableRow key={x.id}>
                      <TableCell><A to={`persoon/${x.id}`}>{x.name}</A></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{[x.email, ...x.ibans.map(formatIban)].filter(Boolean).join(" · ") || "—"}</TableCell>
                      <TableCell className="text-right"><Money value={balance} tone /><span className="ml-2 text-xs text-muted-foreground">{balance > 0 ? "moet betalen" : balance < 0 ? "tegoed" : ""}</span></TableCell>
                      <TableCell className="whitespace-nowrap text-right">
                        {canEdit && <Button variant="ghost" size="sm" onClick={() => setCharge({ partyId: x.id, amount: "", description: "", target: openActs[0] ? `activity:${openActs[0].id}` : `pot:${state.pots[0].id}` })}>Bedrag erop zetten</Button>}
                        {balance > 0 && (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => { void navigator.clipboard?.writeText(text); notify("Betaalverzoek gekopieerd (plak in Tikkie/WhatsApp)", "ok"); }}><Copy /> Betaalverzoek</Button>
                            {x.email && <Button variant="ghost" size="sm" asChild><a href={`mailto:${x.email}?subject=${encodeURIComponent(`Betaalverzoek ${state.settings.name}`)}&body=${encodeURIComponent(text)}`}><Mail /></a></Button>}
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter><TableRow><TableCell colSpan={2}>Totaal nog te ontvangen van externen</TableCell><TableCell className="text-right"><Money value={sum(externals.map((x) => cents(Math.max(0, d.partyBalance.get(x.id) ?? 0))))} /></TableCell><TableCell /></TableRow></TableFooter>
            </Table>
          )}
        </CardContent>
      </Card>
      {charge && (
        <Card>
          <CardHeader><CardTitle>Bedrag op rekening van {d.partyById.get(charge.partyId)?.name}</CardTitle><CardDescription>Bijv. hun deel van een feest (tegen de activiteit) of een factuur voor zaalhuur (tegen een potje). Negatief = tegoed.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Bedrag"><Input value={charge.amount} onChange={(e) => setCharge({ ...charge, amount: e.target.value })} placeholder="120,00" /></Field>
            <Field label="Omschrijving"><Input value={charge.description} onChange={(e) => setCharge({ ...charge, description: e.target.value })} placeholder="Deel openingsfeest" /></Field>
            <Field label="Voor">
              <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" value={charge.target} onChange={(e) => setCharge({ ...charge, target: e.target.value })}>
                <optgroup label="Activiteit">{openActs.map((a) => <option key={a.id} value={`activity:${a.id}`}>{a.number} · {a.name}</option>)}</optgroup>
                <optgroup label="Potje (opbrengst)">{state.pots.map((p) => <option key={p.id} value={`pot:${p.id}`}>{p.name}</option>)}</optgroup>
              </select>
            </Field>
            <div className="flex gap-2">
              <Button onClick={() => run(() => {
                const [kind, id] = charge.target.split(":") as ["activity" | "pot", string];
                store.chargePerson({ partyId: charge.partyId, date: today(), amount: parseAmount(charge.amount), target: { kind, id }, description: charge.description }, actor);
                setCharge(null);
              }, "Geboekt")}>Boeken</Button>
              <Button variant="ghost" onClick={() => setCharge(null)}>Annuleren</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
