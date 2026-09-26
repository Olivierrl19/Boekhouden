import { useRef, useState } from "react";
import { Check, X, Receipt, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { cents } from "@/domain/money";
import { formatDateNl, localDate } from "@/domain/dates";
import { today, type Claim } from "../ledger";
import { Empty, Field, PageHeader, ReadOnlyNotice, Select, parseAmount, useAction, useApp, useCan, useLedger } from "./core";
import { BalanceText, StatementTable } from "./page-people";

const STATUS: Record<Claim["status"], { label: string; variant: "warning" | "success" | "destructive" | "outline" }> = {
  submitted: { label: "ingediend", variant: "warning" },
  approved: { label: "goedgekeurd", variant: "success" },
  rejected: { label: "afgewezen", variant: "destructive" },
  withdrawn: { label: "ingetrokken", variant: "outline" },
};

/** Shrink a photo to a small JPEG data URL so it fits in browser storage. */
async function compressImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Kies een foto van de bon (jpg/png)");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("Kon de foto niet lezen"));
      i.src = url;
    });
    const scale = Math.min(1, 900 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.6);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ClaimForm({ partyId: fixedParty }: { partyId?: string }) {
  const { store, actor, notify } = useApp();
  const { state } = useLedger();
  const run = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const members = state.parties.filter((p) => p.kind === "member" && p.active).sort((a, b) => a.name.localeCompare(b.name));
  const openActs = state.activities.filter((a) => a.status === "open");
  const [f, setF] = useState({ partyId: fixedParty ?? "", amount: "", description: "", target: openActs[0] ? `activity:${openActs[0].id}` : `pot:${state.pots[0]?.id}` });
  const [receipt, setReceipt] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><Receipt className="size-5" /> Declaratie indienen</CardTitle><CardDescription>Na goedkeuring door de fiscus komt het bedrag als tegoed op je rekening.</CardDescription></CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        {!fixedParty && <Field label="Lid"><Select value={f.partyId} onChange={(e) => setF({ ...f, partyId: e.target.value })}><option value="">Kies…</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select></Field>}
        <Field label="Bedrag"><Input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="12,50" inputMode="decimal" /></Field>
        <Field label="Waarvoor"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Chips en fris borrel" /></Field>
        <Field label="Voor activiteit of potje">
          <Select value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })}>
            <optgroup label="Activiteit (wordt verdeeld over deelnemers)">{openActs.map((a) => <option key={a.id} value={`activity:${a.id}`}>{a.name}</option>)}</optgroup>
            <optgroup label="Potje (kosten voor het dispuut)">{state.pots.map((p) => <option key={p.id} value={`pot:${p.id}`}>{p.name}</option>)}</optgroup>
          </Select>
        </Field>
        <Field label="Foto van de bon">
          <span className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent">
            <Receipt className="size-4" /> {receipt ? "Andere foto kiezen" : "Foto kiezen of maken"}
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; try { setReceipt(await compressImage(file)); } catch (err) { notify((err as Error).message, "error"); } }} />
          </span>
        </Field>
        {receipt && <img src={receipt} alt="Bon" className="max-h-40 rounded border sm:col-span-2" />}
        <div className="sm:col-span-2">
          <Button onClick={() => run(() => {
            const [kind, id] = f.target.split(":") as ["activity" | "pot", string];
            store.submitClaim({ partyId: fixedParty ?? f.partyId, amount: parseAmount(f.amount), description: f.description, target: { kind, id }, receipt }, actor);
            setF({ ...f, amount: "", description: "" });
            setReceipt(null);
            if (fileRef.current) fileRef.current.value = "";
          }, "Declaratie ingediend")}>Indienen</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ClaimList({ claims, showParty }: { claims: Claim[]; showParty: boolean }) {
  const { store, actor } = useApp();
  const { state, d } = useLedger();
  const canApprove = useCan("approve");
  const run = useAction();
  const [view, setView] = useState<string | null>(null);
  if (!claims.length) return <Empty>Geen declaraties.</Empty>;
  return (
    <Table>
      <TableHeader><TableRow><TableHead>Ingediend</TableHead>{showParty && <TableHead>Lid</TableHead>}<TableHead>Waarvoor</TableHead><TableHead className="text-right">Bedrag</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>
        {[...claims].reverse().map((c) => (
          <TableRow key={c.id}>
            <TableCell className="whitespace-nowrap">{formatDateNl(localDate(c.submittedAt.slice(0, 10)))}</TableCell>
            {showParty && <TableCell>{d.partyById.get(c.partyId)?.name}</TableCell>}
            <TableCell>
              {c.description}
              <div className="text-xs text-muted-foreground">{c.target.kind === "activity" ? `Activiteit ${state.activities.find((a) => a.id === (c.target as { activityId: string }).activityId)?.name}` : `Potje ${d.potById.get((c.target as { potId: string }).potId)?.name}`}</div>
              {c.rejectionReason && <div className="text-xs text-red-600">Reden: {c.rejectionReason}</div>}
              {view === c.id && c.receipt && <img src={c.receipt} alt="Bon" className="mt-2 max-h-64 rounded border" />}
            </TableCell>
            <TableCell className="text-right"><Money value={c.amount} /></TableCell>
            <TableCell><Badge variant={STATUS[c.status].variant}>{STATUS[c.status].label}</Badge></TableCell>
            <TableCell className="whitespace-nowrap text-right">
              {c.receipt && <Button variant="ghost" size="sm" onClick={() => setView(view === c.id ? null : c.id)}>Bon</Button>}
              {c.status === "submitted" && canApprove && (
                <>
                  <Button size="sm" variant="outline" onClick={() => run(() => store.approveClaim(c.id, today(), actor), "Goedgekeurd: bedrag staat als tegoed op de rekening")}><Check /> Goedkeuren</Button>
                  <Button size="sm" variant="ghost" onClick={() => { const r = window.prompt("Reden van afwijzen?"); if (r) run(() => store.rejectClaim(c.id, r, actor), "Afgewezen"); }}><X /></Button>
                </>
              )}
              {c.status === "submitted" && actor.role === "lid" && actor.partyId === c.partyId && (
                <Button size="sm" variant="ghost" onClick={() => run(() => store.withdrawClaim(c.id, actor), "Ingetrokken")}>Intrekken</Button>
              )}
              {c.status === "approved" && canApprove && (
                <Button size="sm" variant="ghost" title="Goedkeuring terugdraaien" onClick={() => { const r = window.prompt("Waarom draai je de goedkeuring terug?"); if (r) run(() => store.undoClaimApproval(c.id, r, actor), "Goedkeuring teruggedraaid (tegenboeking)"); }}><Undo2 /></Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function ClaimsPage() {
  const { state } = useLedger();
  const canEdit = useCan("edit");
  const pending = state.claims.filter((c) => c.status === "submitted");
  const done = state.claims.filter((c) => c.status !== "submitted");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Declaraties" description="Leden dienen in met een foto van de bon; de fiscus keurt goed of wijst af. Goedgekeurd = tegoed op de rekening van het lid." />
      <ReadOnlyNotice />
      {canEdit && <ClaimForm />}
      <Card><CardHeader><CardTitle>Wachten op goedkeuring ({pending.length})</CardTitle></CardHeader><CardContent className="p-0"><ClaimList claims={pending} showParty /></CardContent></Card>
      <Card><CardHeader><CardTitle>Afgehandeld</CardTitle></CardHeader><CardContent className="p-0"><ClaimList claims={done} showParty /></CardContent></Card>
    </div>
  );
}

export function MyPage() {
  const { actor } = useApp();
  const { state, d } = useLedger();
  const party = actor.partyId ? d.partyById.get(actor.partyId) : null;
  if (!party) return <Empty>Kies rechtsboven een lid om te kijken als dat lid.</Empty>;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Mijn rekening" description={party.name} />
      <Card><CardContent className="p-5"><BalanceText balance={d.partyBalance.get(party.id) ?? cents(0)} /></CardContent></Card>
      <ClaimForm partyId={party.id} />
      <Card><CardHeader><CardTitle>Mijn declaraties</CardTitle></CardHeader><CardContent className="p-0"><ClaimList claims={state.claims.filter((c) => c.partyId === party.id)} showParty={false} /></CardContent></Card>
      <Card><CardHeader><CardTitle>Mutaties</CardTitle></CardHeader><CardContent className="p-0"><StatementTable partyId={party.id} /></CardContent></Card>
    </div>
  );
}
