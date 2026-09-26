import { useState } from "react";
import { PiggyBank, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { cents, formatEuro, sum } from "@/domain/money";
import { formatDateNl, localDate, type LocalDate } from "@/domain/dates";
import { today, type SavingsGoal } from "../ledger";
import { A, Empty, Field, PageHeader, ReadOnlyNotice, parseAmount, useAction, useApp, useCan, useLedger } from "./core";

/** Months between two dates (inclusive of the start month), for "on track" indication. */
function monthsBetween(from: LocalDate, to: LocalDate) {
  return Math.max(0, (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1);
}

export function SavingsPage() {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const isAdmin = useCan("admin");
  const run = useAction();
  const [f, setF] = useState({ name: "", targetDate: "", monthly: "" });
  const [selected, setSelected] = useState<string | null>(null);
  const goals = [...state.savingsGoals].sort((a, b) => Number(b.active) - Number(a.active));
  const goal = goals.find((g) => g.id === selected) ?? goals[0] ?? null;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Spaarplannen" description="Leden sparen bij het dispuut voor bijvoorbeeld de lustrumreis. Dat geld is van het lid (het dispuut bewaart het) en staat apart van contributie en borrelrekening. Bij de reis verreken je het spaargeld met wat iemand moet betalen." />
      <ReadOnlyNotice />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {goals.map((g) => {
          const savers = state.parties.filter((p) => (d.savings.get(`${p.id}|${g.id}`) ?? 0) !== 0).length;
          return (
            <button key={g.id} onClick={() => setSelected(g.id)} className="text-left">
              <Card className={goal?.id === g.id ? "ring-2 ring-primary" : ""}>
                <CardHeader>
                  <CardDescription className="flex items-center gap-2"><PiggyBank className="size-4" /> {g.name} {!g.active && <Badge variant="outline">afgerond</Badge>}</CardDescription>
                  <CardTitle className="text-2xl"><Money value={d.savingsByGoal.get(g.id) ?? 0} /></CardTitle>
                  <CardDescription className="text-xs">{savers} spaarders{g.monthly > 0 && ` · advies ${formatEuro(g.monthly)} per maand`}{g.targetDate && ` · doel ${formatDateNl(g.targetDate)}`}</CardDescription>
                </CardHeader>
              </Card>
            </button>
          );
        })}
      </div>
      {isAdmin && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Plus className="size-5" /> Nieuw spaardoel</CardTitle></CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-4 sm:items-end">
            <Field label="Naam"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Lustrumreis 2028" /></Field>
            <Field label="Doeldatum"><Input type="date" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} /></Field>
            <Field label="Advies per maand"><Input value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} placeholder="20,00" /></Field>
            <Button onClick={() => run(() => { store.createSavingsGoal({ name: f.name, targetDate: f.targetDate ? localDate(f.targetDate) : null, monthly: f.monthly ? parseAmount(f.monthly) : cents(0) }, actor); setF({ name: "", targetDate: "", monthly: "" }); }, "Spaardoel aangemaakt")}>Aanmaken</Button>
          </CardContent>
        </Card>
      )}
      {goal ? <GoalDetail goal={goal} /> : <Empty>Nog geen spaardoelen.</Empty>}
    </div>
  );
}

function GoalDetail({ goal }: { goal: SavingsGoal }) {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const canApprove = useCan("approve");
  const isAdmin = useCan("admin");
  const run = useAction();
  const [showAll, setShowAll] = useState(false);
  const members = state.parties.filter((p) => p.kind === "member" && (showAll ? p.active : (d.savings.get(`${p.id}|${goal.id}`) ?? 0) !== 0)).sort((a, b) => a.name.localeCompare(b.name));
  const firstDeposit = (partyId: string) =>
    state.entries.filter((e) => e.lines.some((l) => l.partyId === partyId && l.savingsGoalId === goal.id)).map((e) => e.date).sort()[0];
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-end justify-between gap-3">
        <div>
          <CardTitle>{goal.name}</CardTitle>
          <CardDescription>Inleggen gaat via de bank: wijs een betaling toe als “Spaarplan van lid”. Uitbetalen ook (bankregel af → spaarplan).</CardDescription>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Alle leden tonen</label>
          {canApprove && goal.active && (
            <Button variant="outline" onClick={() => {
              if (!window.confirm(`Voor elk lid het spaargeld van “${goal.name}” gebruiken om wat hij/zij op de rekening moet te betalen? (Nooit meer dan gespaard.)`)) return;
              run(() => {
                const r = store.settleSavingsForGoal(goal.id, today(), "owed", actor);
                if (!r.members) throw new Error("Er is niets te verrekenen (niemand met spaargeld heeft een openstaand saldo)");
              }, "Spaargeld verrekend met de rekeningen");
            }}>Verreken met openstaande saldi</Button>
          )}
          {isAdmin && (
            <Button variant="ghost" onClick={() => run(() => store.updateSavingsGoal(goal.id, { name: goal.name, targetDate: goal.targetDate, monthly: goal.monthly, active: !goal.active }, actor), goal.active ? "Spaardoel afgerond" : "Spaardoel heropend")}>{goal.active ? "Afronden" : "Heropenen"}</Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lid</TableHead>
              <TableHead className="text-right">Gespaard</TableHead>
              {goal.monthly > 0 && <TableHead className="text-right">Op schema?</TableHead>}
              <TableHead className="text-right">Rekening</TableHead>
              {canApprove && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => {
              const saved = d.savings.get(`${m.id}|${goal.id}`) ?? cents(0);
              const start = firstDeposit(m.id);
              const expected = start ? monthsBetween(start, today()) * goal.monthly : 0;
              return (
                <TableRow key={m.id}>
                  <TableCell><A to={`persoon/${m.id}`}>{m.name}</A></TableCell>
                  <TableCell className="text-right font-medium"><Money value={saved} /></TableCell>
                  {goal.monthly > 0 && (
                    <TableCell className="text-right text-xs">
                      {!start ? <span className="text-muted-foreground">nog niet gestart</span> : saved >= expected ? <Badge variant="success">op schema</Badge> : <Badge variant="warning">{formatEuro(cents(expected - saved))} achter</Badge>}
                    </TableCell>
                  )}
                  <TableCell className="text-right"><Money value={d.partyBalance.get(m.id) ?? 0} tone /></TableCell>
                  {canApprove && (
                    <TableCell className="text-right">
                      {saved > 0 && (
                        <Button variant="ghost" size="sm" onClick={() => {
                          const input = window.prompt(`Hoeveel van het spaargeld van ${m.name} (${formatEuro(saved)}) verrekenen met de rekening?`, (Math.min(saved, Math.max(0, d.partyBalance.get(m.id) ?? 0) || saved) / 100).toFixed(2).replace(".", ","));
                          if (input) run(() => store.settleSavings({ partyId: m.id, goalId: goal.id, amount: parseAmount(input), date: today() }, actor), "Verrekend");
                        }}>Verrekenen</Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow>
              <TableCell>Totaal</TableCell>
              <TableCell className="text-right"><Money value={sum(members.map((m) => d.savings.get(`${m.id}|${goal.id}`) ?? cents(0)))} /></TableCell>
              <TableCell colSpan={3} />
            </TableRow>
          </TableFooter>
        </Table>
        {members.length === 0 && <Empty>Nog niemand spaart voor dit doel.</Empty>}
      </CardContent>
    </Card>
  );
}
