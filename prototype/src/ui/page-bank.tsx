import { useMemo, useRef, useState } from "react";
import { Upload, Download, Coins, Undo2, Check, Sparkles, Plus, Trash2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { decodeBankFile, looksLikeRabobankCsv, parseRabobankCsv } from "@/domain/bank/rabobank-csv";
import { payerIban } from "@/domain/bank/suggestions";
import { formatIban } from "@/domain/bank/iban";
import { formatDateNl, localDate } from "@/domain/dates";
import { cents, formatEuro, sum, type Cents } from "@/domain/money";
import type { AssignPart, BankTx, ImportResult } from "../ledger";
import { nextDemoCsv } from "../demo";
import { today } from "../ledger";
import { Empty, Field, PageHeader, ReadOnlyNotice, Select, download, parseAmount, useAction, useApp, useCan, useLedger } from "./core";
import { whereBooked } from "./labels";

type Kind = AssignPart["kind"];
interface Part { kind: Kind; id: string; goalId?: string; donorId?: string; amount: string }

export function BankPage() {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const canEdit = useCan("edit");
  const run = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<(ImportResult & { file: string }) | null>(null);
  const [tab, setTab] = useState<"open" | "all">("open");
  const [showCash, setShowCash] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const unassigned = useMemo(() => [...d.unassigned].sort((a, b) => (a.bookingDate < b.bookingDate ? -1 : 1)), [d]);
  const current = unassigned.find((t) => t.id === selected) ?? unassigned[0] ?? null;

  async function onFile(file: File) {
    const text = decodeBankFile(await file.arrayBuffer());
    run(() => {
      if (!looksLikeRabobankCsv(text)) throw new Error("Dit is geen Rabobank CSV-export. Kies in Rabo Internetbankieren: Transacties downloaden → CSV.");
      const r = store.importTransactions(parseRabobankCsv(text), actor, { fileName: file.name });
      setResult({ ...r, file: file.name });
    });
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div>
      <PageHeader title="Bank" description="Elke bankregel moet een plek krijgen: waar geboekt? Nul openstaand betekent: de boekhouding is bij.">
        {canEdit && (
          <>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            <Button onClick={() => fileRef.current?.click()}><Upload /> Rabobank-CSV importeren</Button>
            <Button variant="outline" onClick={() => setShowManual((v) => !v)}><Plus /> Transactie met de hand</Button>
            <Button variant="outline" onClick={() => setShowCash((v) => !v)}><Coins /> Kasmutatie</Button>
          </>
        )}
        {state.settings.isDemo && (
          <Button
            variant="outline"
            onClick={() => {
              const f = nextDemoCsv(state, today());
              download(f.fileName, f.csv);
            }}
          >
            <Download /> Voorbeeld-CSV
          </Button>
        )}
      </PageHeader>
      <ReadOnlyNotice />

      {state.settings.isDemo && canEdit && (
        <p className="mb-4 text-sm text-muted-foreground">
          Demo: klik op <strong>Voorbeeld-CSV</strong> om een Rabobank-bestand met nieuwe transacties te downloaden, en importeer het daarna. Importeer je hetzelfde bestand twee keer, dan wordt niets dubbel geboekt.
        </p>
      )}

      {result && (
        <div className="mb-4 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
          <strong>{result.file}</strong>: {result.added} nieuw, {result.duplicates} al eerder geïmporteerd
          {result.autoAssigned > 0 && `, ${result.autoAssigned} interne overboeking(en) automatisch geboekt`}. Banksaldo sluit aan op de bank.
        </div>
      )}

      {showCash && <CashForm onDone={() => setShowCash(false)} />}
      {showManual && <ManualForm onDone={() => setShowManual(false)} />}

      <div className="mb-4 flex gap-2">
        <Button variant={tab === "open" ? "default" : "outline"} size="sm" onClick={() => setTab("open")}>Nog toe te wijzen ({unassigned.length})</Button>
        <Button variant={tab === "all" ? "default" : "outline"} size="sm" onClick={() => setTab("all")}>Alle transacties</Button>
      </div>

      {tab === "open" ? (
        unassigned.length === 0 ? (
          <Card><CardContent className="p-6 text-center"><Check className="mx-auto mb-2 size-8 text-emerald-600" /><div className="font-medium">Alles is toegewezen. De boekhouding is bij.</div></CardContent></Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Datum</TableHead>
                      <TableHead>Bij/af</TableHead>
                      <TableHead className="text-right">Bedrag</TableHead>
                      <TableHead>Tegenpartij</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unassigned.map((t) => (
                      <TableRow key={t.id} onClick={() => setSelected(t.id)} className={`cursor-pointer ${current?.id === t.id ? "bg-accent" : ""}`}>
                        <TableCell className="whitespace-nowrap">{formatDateNl(t.bookingDate)}</TableCell>
                        <TableCell><Badge variant={t.amount > 0 ? "success" : "destructive"}>{t.amount > 0 ? "bij" : "af"}</Badge></TableCell>
                        <TableCell className="text-right"><Money value={Math.abs(t.amount)} /></TableCell>
                        <TableCell>
                          <div className="max-w-56 truncate">{t.counterpartyName ?? "—"}</div>
                          <div className="max-w-56 truncate text-xs text-muted-foreground">{t.description}</div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            {current && <AssignPanel key={current.id} tx={current} />}
          </div>
        )
      ) : (
        <AllTransactions />
      )}
    </div>
  );
}

function CashForm({ onDone }: { onDone: () => void }) {
  const { store, actor } = useApp();
  const run = useAction();
  const [date, setDate] = useState<string>(today());
  const [dir, setDir] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  return (
    <Card className="mb-4">
      <CardHeader><CardTitle>Kasmutatie</CardTitle><CardDescription>Contant geld in of uit de kas. Daarna wijs je hem toe, net als een bankregel.</CardDescription></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-5 sm:items-end">
        <Field label="Datum"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="In/uit"><Select value={dir} onChange={(e) => setDir(e.target.value as "in" | "out")}><option value="in">In de kas</option><option value="out">Uit de kas</option></Select></Field>
        <Field label="Bedrag"><Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="12,50" inputMode="decimal" /></Field>
        <Field label="Omschrijving"><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Contant van Jan" /></Field>
        <Button onClick={() => run(() => {
          const a = parseAmount(amount);
          store.recordCash({ date: localDate(date), amount: cents(dir === "in" ? Math.abs(a) : -Math.abs(a)), description: desc }, actor);
          onDone();
        }, "Kasmutatie vastgelegd")}>Vastleggen</Button>
      </CardContent>
    </Card>
  );
}

function ManualForm({ onDone }: { onDone: () => void }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const run = useAction();
  const banks = state.bankAccounts.filter((b) => b.kind !== "cash");
  const [f, setF] = useState({ bankAccountId: banks[0]?.id ?? "", date: today() as string, dir: "in", amount: "", name: "", iban: "", description: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle>Banktransactie met de hand toevoegen</CardTitle>
        <CardDescription>Voor als je (nog) geen bankbestand hebt. Importeer je later de export, dan herkent de app deze transactie (zelfde bedrag, hooguit 3 dagen verschil) en boekt hij hem niet dubbel.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <Field label="Rekening"><Select value={f.bankAccountId} onChange={set("bankAccountId")}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <Field label="Datum"><Input type="date" value={f.date} onChange={set("date")} /></Field>
        <Field label="Bij/af"><Select value={f.dir} onChange={set("dir")}><option value="in">Bij (ontvangen)</option><option value="out">Af (betaald)</option></Select></Field>
        <Field label="Bedrag"><Input value={f.amount} onChange={set("amount")} placeholder="15,00" inputMode="decimal" /></Field>
        <Field label="Tegenpartij"><Input value={f.name} onChange={set("name")} placeholder="Naam" /></Field>
        <Field label="IBAN tegenpartij (optioneel)"><Input value={f.iban} onChange={set("iban")} placeholder="NL.." /></Field>
        <Field label="Omschrijving"><Input value={f.description} onChange={set("description")} /></Field>
        <Button onClick={() => run(() => {
          const a = Math.abs(parseAmount(f.amount));
          store.addManualBankTransaction({ bankAccountId: f.bankAccountId, date: localDate(f.date), amount: cents(f.dir === "in" ? a : -a), counterpartyName: f.name, counterpartyIban: f.iban || null, description: f.description }, actor);
          onDone();
        }, "Transactie toegevoegd; wijs hem nu toe")}>Toevoegen</Button>
      </CardContent>
    </Card>
  );
}

function TargetSelect({ part, onChange, incoming }: { part: Part; onChange: (p: Part) => void; incoming: boolean }) {
  const { state } = useLedger();
  const members = state.parties.filter((p) => p.kind === "member").sort((a, b) => a.name.localeCompare(b.name));
  const externals = state.parties.filter((p) => p.kind === "external").sort((a, b) => a.name.localeCompare(b.name));
  const openActs = state.activities.filter((a) => a.status === "open");
  const goals = state.savingsGoals.filter((g) => g.active);
  const personId = part.kind === "person" || part.kind === "contribution" || part.kind === "savings" ? part.id : "";
  return (
    <div className="grid gap-2 sm:grid-cols-[13rem_1fr]">
      <Select value={part.kind} onChange={(e) => onChange({ ...part, kind: e.target.value as Kind, id: ["person", "contribution", "savings"].includes(e.target.value) ? personId : "", goalId: goals[0]?.id })}>
        <option value="contribution">Contributie van lid</option>
        <option value="person">Rekening van persoon</option>
        <option value="savings">Spaarplan van lid</option>
        <option value="activity">Activiteit</option>
        <option value="pot">Potje / donatie</option>
        <option value="internal">Interne overboeking</option>
      </Select>
      {(part.kind === "contribution" || part.kind === "savings") && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={part.id} onChange={(e) => onChange({ ...part, id: e.target.value })}>
            <option value="">Kies een lid…</option>
            {members.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? "" : " (uitgeschreven)"}</option>)}
          </Select>
          {part.kind === "savings" && (
            <Select value={part.goalId ?? ""} onChange={(e) => onChange({ ...part, goalId: e.target.value })}>
              {goals.length === 0 && <option value="">Maak eerst een spaardoel aan</option>}
              {goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          )}
        </div>
      )}
      {part.kind === "person" && (
        <Select value={part.id} onChange={(e) => onChange({ ...part, id: e.target.value })}>
          <option value="">Kies een persoon…</option>
          <optgroup label="Leden">{members.map((p) => <option key={p.id} value={p.id}>{p.name}{p.active ? "" : " (uitgeschreven)"}</option>)}</optgroup>
          <optgroup label="Externen">{externals.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</optgroup>
        </Select>
      )}
      {part.kind === "activity" && (
        <Select value={part.id} onChange={(e) => onChange({ ...part, id: e.target.value })}>
          <option value="">Kies een activiteit…</option>
          {openActs.map((a) => <option key={a.id} value={a.id}>{a.number} · {a.name}</option>)}
        </Select>
      )}
      {part.kind === "pot" && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={part.id} onChange={(e) => onChange({ ...part, id: e.target.value })}>
            <option value="">Kies een potje…</option>
            {state.pots.map((p) => <option key={p.id} value={p.id}>{p.name} ({incoming ? "opbrengst" : "kosten"})</option>)}
          </Select>
          {incoming && (
            <Select value={part.donorId ?? ""} onChange={(e) => onChange({ ...part, donorId: e.target.value })} title="Van wie (bijv. bij een donatie)">
              <option value="">Van wie? (optioneel)</option>
              {[...members, ...externals].map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </div>
      )}
      {part.kind === "internal" && <div className="self-center text-sm text-muted-foreground">Naar/van een eigen rekening</div>}
    </div>
  );
}

function AssignPanel({ tx }: { tx: BankTx }) {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const canEdit = useCan("edit");
  const run = useAction();
  const suggestions = useMemo(() => store.suggestions(tx.id), [store, tx.id, state]); // eslint-disable-line react-hooks/exhaustive-deps
  const incoming = tx.amount > 0;
  const initial: Part = suggestions[0] ? { ...targetToPart(suggestions[0].target), amount: "" } : { kind: incoming ? "contribution" : "pot", id: "", amount: "" };
  const [parts, setParts] = useState<Part[]>([initial]);
  const split = parts.length > 1;
  const ownIbans = state.bankAccounts.map((b) => b.iban).filter((x): x is string => !!x);
  const payer = payerIban(tx, ownIbans);
  const payerKnown = !!payer && state.parties.some((p) => p.ibans.includes(payer));
  const [remember, setRemember] = useState(true);

  const partAmounts = (): Cents[] => {
    if (!split) return [tx.amount];
    return parts.map((p) => {
      const a = parseAmount(p.amount);
      return cents(Math.sign(tx.amount) * Math.abs(a));
    });
  };
  let remaining: number | null = null;
  if (split) {
    try {
      remaining = tx.amount - sum(parts.map((p) => (p.amount.trim() ? cents(Math.sign(tx.amount) * Math.abs(parseAmount(p.amount))) : cents(0))));
    } catch {
      remaining = null;
    }
  }

  const book = () =>
    run(() => {
      const amounts = partAmounts();
      store.assign(
        tx.id,
        parts.map((p, i) => ({ kind: p.kind, id: p.id, goalId: p.goalId, donorId: p.donorId || null, amount: amounts[i] })),
        actor,
        { rememberIbanFor: !split && ["person", "contribution", "savings"].includes(parts[0].kind) && remember && payer && !payerKnown ? parts[0].id : null },
      );
    }, "Geboekt");

  return (
    <Card className="self-start lg:sticky lg:top-4">
      <CardHeader>
        <CardDescription>{formatDateNl(tx.bookingDate)} · {state.bankAccounts.find((b) => b.id === tx.bankAccountId)?.name}</CardDescription>
        <CardTitle className="text-2xl"><Money value={tx.amount} /> <span className="text-base font-normal text-muted-foreground">{incoming ? "bij" : "af"}</span></CardTitle>
        <div className="text-sm">
          <div className="font-medium">{tx.counterpartyName ?? "Onbekende tegenpartij"}</div>
          {tx.counterpartyIban && <div className="font-mono text-xs text-muted-foreground">{formatIban(tx.counterpartyIban)}</div>}
          <div className="mt-1 text-muted-foreground">{tx.description}</div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {suggestions.length > 0 && (
          <div className="flex flex-col gap-2">
            {suggestions.map((sg, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm dark:border-sky-900 dark:bg-sky-950/40">
                <span className="flex items-center gap-2"><Sparkles className="size-4 text-sky-600" />{sg.label}</span>
                {canEdit && (
                  <Button size="sm" onClick={() => run(() => {
                    const p = targetToPart(sg.target);
                    store.assign(tx.id, [{ kind: p.kind, id: p.id, goalId: p.goalId, amount: tx.amount }], actor);
                  }, "Geboekt")}>Boek zo</Button>
                )}
              </div>
            ))}
          </div>
        )}

        {canEdit ? (
          <>
            <div className="text-sm font-medium">Waar geboekt?</div>
            {parts.map((p, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-md border p-3">
                <TargetSelect part={p} incoming={incoming} onChange={(np) => setParts(parts.map((x, j) => (j === i ? np : x)))} />
                {split && (
                  <div className="flex gap-2">
                    <Input placeholder="Bedrag" inputMode="decimal" value={p.amount} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                    <Button variant="ghost" size="icon" onClick={() => setParts(parts.filter((_, j) => j !== i))} aria-label="Verwijder"><Trash2 /></Button>
                  </div>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between text-sm">
              <Button variant="outline" size="sm" onClick={() => setParts(split ? [...parts, { kind: "pot", id: "", amount: "" }] : [{ ...parts[0], amount: "" }, { kind: "pot", id: "", amount: "" }])}>
                <Plus /> {split ? "Nog een regel" : "Splitsen over meerdere"}
              </Button>
              {split && remaining !== null && (
                <span className={remaining === 0 ? "text-emerald-700" : "text-amber-700"}>
                  {remaining === 0 ? "Precies verdeeld" : `Nog ${formatEuro(cents(Math.abs(remaining)))} te verdelen`}
                </span>
              )}
            </div>
            {!split && ["person", "contribution", "savings"].includes(parts[0].kind) && parts[0].id && payer && !payerKnown && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                IBAN {formatIban(payer)} onthouden, zodat de app deze persoon volgende keer voorstelt
              </label>
            )}
            <Button onClick={book}>Boeken</Button>
            {tx.counterpartyName && !payerKnown && <NewPersonFromTx tx={tx} onCreated={(id, kind) => setParts([{ kind: kind === "member" ? "contribution" : "person", id, amount: "" }])} />}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Alleen fiscus en bestuur kunnen toewijzen.</p>
        )}
        <p className="text-xs text-muted-foreground">Bijna niets wordt vanzelf geboekt: alleen overboekingen tussen jullie eigen rekeningen. Een voorstel bevestig je altijd zelf.</p>
        {d.unassigned.length > 1 && <p className="text-xs text-muted-foreground">Na boeken ga je door naar de volgende regel.</p>}
      </CardContent>
    </Card>
  );
}

function AllTransactions() {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const canEdit = useCan("edit");
  const run = useAction();
  const [accountId, setAccountId] = useState(state.bankAccounts[0]?.id ?? "");
  const [q, setQ] = useState("");
  const rows = state.bankTransactions
    .filter((t) => t.bankAccountId === accountId)
    .filter((t) => !q || `${t.counterpartyName} ${t.description}`.toLowerCase().includes(q.toLowerCase()))
    .slice()
    .reverse()
    .slice(0, 300);
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-3">
        <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="w-56">
          {state.bankAccounts.map((b) => <option key={b.id} value={b.id}>{b.name} ({formatEuro(d.bankBalance.get(b.id) ?? cents(0))})</option>)}
        </Select>
        <Input placeholder="Zoeken…" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? <Empty>Geen transacties.</Empty> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datum</TableHead>
                <TableHead className="text-right">Bedrag</TableHead>
                <TableHead>Tegenpartij / omschrijving</TableHead>
                <TableHead>Waar geboekt</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => {
                const entry = store.assignmentOf(t.id);
                const open = (d.suspenseByTx.get(t.id) ?? 0) !== 0;
                return (
                  <TableRow key={t.id}>
                    <TableCell className="whitespace-nowrap">{formatDateNl(t.bookingDate)}</TableCell>
                    <TableCell className="text-right"><Money value={t.amount} /></TableCell>
                    <TableCell>
                      <div className="max-w-64 truncate">{t.counterpartyName ?? "—"}{t.manual && <Badge variant="outline" className="ml-2">{t.matchedExternalId ? "handmatig, bevestigd door bank" : "handmatig"}</Badge>}</div>
                      <div className="max-w-64 truncate text-xs text-muted-foreground">{t.description}</div>
                    </TableCell>
                    <TableCell>
                      {open ? <Badge variant="warning">nog toewijzen</Badge> : (
                        <span className="text-sm">{whereBooked(state, d, entry)}{entry?.isAutomatic && <Badge variant="secondary" className="ml-2">automatisch</Badge>}</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">{t.balanceAfter !== null && <Money value={t.balanceAfter} />}</TableCell>
                    <TableCell className="text-right">
                      {canEdit && entry && (
                        <Button variant="ghost" size="sm" title="Toewijzing ongedaan maken" onClick={() => {
                          const reason = window.prompt("Waarom maak je deze toewijzing ongedaan?");
                          if (reason) run(() => store.unassign(t.id, reason, actor), "Toewijzing teruggedraaid (tegenboeking)");
                        }}><Undo2 /></Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function targetToPart(t: import("@/domain/bank/suggestions").SuggestionTarget): Part {
  switch (t.kind) {
    case "person": return { kind: "person", id: t.partyId, amount: "" };
    case "contribution": return { kind: "contribution", id: t.partyId, amount: "" };
    case "savings": return { kind: "savings", id: t.partyId, goalId: t.goalId, amount: "" };
    case "activity": return { kind: "activity", id: t.activityId, amount: "" };
    case "pot": return { kind: "pot", id: t.potId, amount: "" };
    case "internal": return { kind: "internal", id: "", amount: "" };
  }
}

/** Unknown counterparty? Create a member or external straight from the bank line (with its IBAN). */
function NewPersonFromTx({ tx, onCreated }: { tx: BankTx; onCreated: (id: string, kind: "member" | "external") => void }) {
  const { store, actor } = useApp();
  const { state } = useLedger();
  const run = useAction();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"external" | "member">("external");
  const [name, setName] = useState(tx.counterpartyName ?? "");
  const ownIbans = state.bankAccounts.map((b) => b.iban).filter((x): x is string => !!x);
  const iban = payerIban(tx, ownIbans);
  if (!open) return <Button variant="ghost" size="sm" className="self-start" onClick={() => setOpen(true)}><UserPlus /> Onbekend? Maak “{tx.counterpartyName}” aan als lid of externe</Button>;
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="grid gap-2 sm:grid-cols-[9rem_1fr]">
        <Select value={kind} onChange={(e) => setKind(e.target.value as "external" | "member")}><option value="external">Externe</option><option value="member">Lid</option></Select>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "member" ? "Voornaam Achternaam" : "Naam"} />
      </div>
      {iban && <span className="text-xs text-muted-foreground">IBAN {formatIban(iban)} wordt onthouden.</span>}
      <Button size="sm" className="self-start" onClick={() => run(() => {
        let id: string;
        if (kind === "external") id = store.createExternal({ name, ibans: iban ? [iban] : [] }, actor).id;
        else {
          const [first, ...rest] = name.trim().split(/\s+/);
          const type = state.memberTypes.find((t) => t.active) ?? state.memberTypes[0];
          if (!type) throw new Error("Maak eerst een soort lid aan (Leden)");
          id = store.createMember({ firstName: first ?? "", lastName: rest.join(" ") || "-", memberTypeId: type.id, joinedOn: tx.bookingDate, ibans: iban ? [iban] : [] }, actor).id;
        }
        onCreated(id, kind);
        setOpen(false);
      }, "Aangemaakt; kies nu waar het geboekt wordt")}>Aanmaken</Button>
    </div>
  );
}
