import { useCallback, useMemo, useState } from "react";
import { BookOpen, CalendarCheck, Home, Landmark, ListChecks, Menu, PartyPopper, Receipt, Settings, ShieldCheck, User, Users, Wallet, BarChart3, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { can, derive, type Actor, type LedgerStore } from "../ledger";
import { AppProvider, Empty, Select, useApp, useLedger, useRoute } from "./core";
import { BankPage } from "./page-bank";
import { ContributionPage, DashboardPage, DebtorsPage, MembersPage, PersonPage } from "./page-people";
import { ActivitiesPage, ActivityPage } from "./page-activities";
import { ClaimsPage, MyPage } from "./page-claims";
import { ControlPage, JournalPage, ReportsPage, SettingsPage, YearPage } from "./page-books";

const ROLE_LABEL = { fiscus: "Fiscus", bestuur: "Bestuur", kascommissie: "Kascommissie", lid: "Lid" } as const;

interface Toast { id: number; message: string; kind: "ok" | "error" }

export function App({ store, onReset }: { store: LedgerStore; onReset: () => void }) {
  const [actor, setActorState] = useState<Actor>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("boekhouding-actor") ?? "null");
      if (saved?.role) return saved;
    } catch { /* ignore */ }
    return { role: "fiscus", partyId: null, label: "Fiscus" };
  });
  const setActor = useCallback((a: Actor) => {
    setActorState(a);
    try { localStorage.setItem("boekhouding-actor", JSON.stringify(a)); } catch { /* ignore */ }
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const notify = useCallback((message: string, kind: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 3500);
  }, []);
  const value = useMemo(() => ({ store, actor, setActor, notify }), [store, actor, setActor, notify]);
  return (
    <AppProvider value={value}>
      <Shell onReset={onReset} />
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2 print:hidden">
        {toasts.map((t) => (
          <div key={t.id} className={cn("rounded-lg border px-4 py-3 text-sm shadow-lg", t.kind === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100" : "border-red-300 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100")}>
            {t.message}
          </div>
        ))}
      </div>
    </AppProvider>
  );
}

function RoleSwitcher() {
  const { state } = useLedger();
  const ctx = useApp();
  const members = state.parties.filter((p) => p.kind === "member" && p.active).sort((a, b) => a.name.localeCompare(b.name));
  const value = ctx.actor.role === "lid" ? `lid:${ctx.actor.partyId}` : ctx.actor.role;
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">Bekijk als (demo van rollen)</span>
      <Select
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v.startsWith("lid:")) {
            const p = state.parties.find((x) => x.id === v.slice(4))!;
            ctx.setActor({ role: "lid", partyId: p.id, label: `${p.name} (lid)` });
            window.location.hash = "#/mijn";
          } else {
            ctx.setActor({ role: v as Actor["role"], partyId: null, label: ROLE_LABEL[v as Actor["role"]] });
            if (window.location.hash.startsWith("#/mijn")) window.location.hash = "#/";
          }
        }}
      >
        <option value="fiscus">Fiscus (alles, keurt goed)</option>
        <option value="bestuur">Bestuur (inzien en bewerken)</option>
        <option value="kascommissie">Kascommissie (alleen kijken)</option>
        <optgroup label="Lid (eigen rekening)">
          {members.map((m) => <option key={m.id} value={`lid:${m.id}`}>{m.name}</option>)}
        </optgroup>
      </Select>
    </div>
  );
}


function Shell({ onReset }: { onReset: () => void }) {
  const { actor } = useApp();
  const { state } = useLedger();
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const d = derive(state);
  const [page, id] = route;
  const viewAll = can(actor, "viewAll");
  const pendingClaims = state.claims.filter((c) => c.status === "submitted").length;

  const items = viewAll
    ? [
        { to: "", label: "Overzicht", icon: Home },
        { to: "bank", label: "Bank", icon: Landmark, badge: d.unassigned.length },
        { to: "debiteuren", label: "Debiteurenlijst", icon: Wallet },
        { to: "activiteiten", label: "Activiteiten", icon: PartyPopper },
        { to: "declaraties", label: "Declaraties", icon: Receipt, badge: pendingClaims },
        { to: "leden", label: "Leden", icon: Users },
        { to: "contributie", label: "Contributie", icon: CalendarCheck },
        { to: "rapporten", label: "Rapportages", icon: BarChart3 },
        { to: "journaal", label: "Journaal", icon: BookOpen },
        { to: "boekjaar", label: "Boekjaar", icon: ListChecks },
        { to: "controle", label: "Controle", icon: ShieldCheck },
        { to: "instellingen", label: "Back-up", icon: Settings },
      ]
    : [{ to: "mijn", label: "Mijn rekening", icon: User }];

  let content: React.ReactNode;
  const month = window.location.hash.match(/maand=(\d{4}-\d{2})/)?.[1];
  if (!viewAll && page !== "mijn") content = <MyPage />;
  else {
    switch (page ?? "") {
      case "": content = <DashboardPage />; break;
      case "bank": content = <BankPage />; break;
      case "debiteuren": content = <DebtorsPage />; break;
      case "persoon": content = <PersonPage key={id} id={(id ?? "").split("?")[0]} monthParam={month} />; break;
      case "activiteiten": content = <ActivitiesPage />; break;
      case "activiteit": content = <ActivityPage key={id} id={id ?? ""} />; break;
      case "declaraties": content = <ClaimsPage />; break;
      case "leden": content = <MembersPage />; break;
      case "contributie": content = <ContributionPage />; break;
      case "rapporten": content = <ReportsPage />; break;
      case "journaal": content = <JournalPage />; break;
      case "boekjaar": content = <YearPage />; break;
      case "controle": content = <ControlPage />; break;
      case "instellingen": content = <SettingsPage onReset={onReset} />; break;
      case "mijn": content = <MyPage />; break;
      default: content = <Empty>Pagina niet gevonden.</Empty>;
    }
  }

  const nav = (
    <nav className="flex flex-col gap-1" onClick={() => setMenuOpen(false)}>
      {items.map((it) => {
        const active = (page ?? "") === it.to || (it.to === "debiteuren" && page === "persoon") || (it.to === "activiteiten" && page === "activiteit");
        const Icon = it.icon;
        return (
          <a key={it.to} href={`#/${it.to}`} className={cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", active && "bg-accent font-medium text-foreground")}>
            <Icon className="size-4" />
            <span className="flex-1">{it.label}</span>
            {!!("badge" in it && it.badge) && <span className="rounded-full bg-amber-500 px-2 text-xs font-semibold text-white">{it.badge}</span>}
          </a>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <header className="flex items-center justify-between border-b p-3 md:hidden print:hidden">
        <span className="font-semibold">{state.settings.name}</span>
        <button onClick={() => setMenuOpen((v) => !v)} aria-label="Menu" className="rounded-md p-2 hover:bg-accent">{menuOpen ? <X className="size-5" /> : <Menu className="size-5" />}</button>
      </header>
      <aside className={cn("border-b bg-muted/30 p-4 md:block md:w-64 md:shrink-0 md:border-b-0 md:border-r print:hidden", menuOpen ? "block" : "hidden")}>
        <div className="mb-5 hidden px-3 md:block">
          <div className="font-semibold">{state.settings.name}</div>
          <div className="text-xs text-muted-foreground">Boekhouding · prototype</div>
        </div>
        {nav}
        <div className="mt-6 border-t px-1 pt-4">
          <RoleSwitcher />
          <div className="mt-2"><Badge variant="secondary">{ROLE_LABEL[actor.role]}</Badge></div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        {state.settings.isDemo && (
          <div className="mb-6 rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm dark:border-sky-900 dark:bg-sky-950/40 print:hidden">
            Dit is een <strong>voorbeelddispuut</strong>. Alles werkt echt; wissen kan bij Back-up. Wissel links onderin van rol om te zien wat een lid, het bestuur of de kascommissie ziet.
          </div>
        )}
        {content}
      </main>
    </div>
  );
}
