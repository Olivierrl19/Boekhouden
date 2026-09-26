import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { LedgerStore, can, derive, type Actor, type Capability, type State } from "../ledger";
import { parseEuroString, type Cents } from "@/domain/money";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Store + actor context
// ---------------------------------------------------------------------------

interface AppContextValue {
  store: LedgerStore;
  actor: Actor;
  setActor: (a: Actor) => void;
  notify: (message: string, kind?: "ok" | "error") => void;
}
const AppContext = createContext<AppContextValue | null>(null);
export const AppProvider = AppContext.Provider;

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("AppContext missing");
  return ctx;
}

export function useLedger(): { state: State; d: ReturnType<typeof derive> } {
  const { store } = useApp();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return { state, d: derive(state) };
}

export function useCan(capability: Capability) {
  return can(useApp().actor, capability);
}

/** Run a store action; show the (Dutch) error message or a success message. Returns success. */
export function useAction() {
  const { notify } = useApp();
  return useCallback(
    (fn: () => unknown, success?: string): boolean => {
      try {
        fn();
        if (success) notify(success, "ok");
        return true;
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), "error");
        return false;
      }
    },
    [notify],
  );
}

// ---------------------------------------------------------------------------
// Hash router
// ---------------------------------------------------------------------------

export function useRoute(): string[] {
  const read = () => (window.location.hash.replace(/^#\/?/, "") || "").split("/").filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(path: string) {
  window.location.hash = path.startsWith("#") ? path : `#/${path.replace(/^\//, "")}`;
}

export function A({ to, className, children }: { to: string; className?: string; children: ReactNode }) {
  return (
    <a href={`#/${to.replace(/^\//, "")}`} className={cn("hover:underline underline-offset-4", className)}>
      {children}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Small form helpers
// ---------------------------------------------------------------------------

export function parseAmount(input: string): Cents {
  const v = input.trim();
  if (!v) throw new Error("Vul een bedrag in");
  try {
    return parseEuroString(v);
  } catch {
    throw new Error(`"${input}" is geen geldig bedrag (gebruik bijv. 12,50)`);
  }
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn("h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn("min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      {...props}
    />
  );
}

export function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return (
    <label className={cn("flex flex-col gap-1.5 text-sm", className)}>
      <span className="font-medium">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between print:mb-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap gap-2 print:hidden">{children}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}

export function ReadOnlyNotice() {
  const { actor } = useApp();
  if (actor.role !== "kascommissie") return null;
  return (
    <div className="mb-4 rounded-lg border border-violet-300 bg-violet-50 p-3 text-sm dark:border-violet-900 dark:bg-violet-950/40 print:hidden">
      Je kijkt als <strong>kascommissie</strong>: je ziet alles, maar kunt niets wijzigen.
    </div>
  );
}

export function download(fileName: string, content: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvLine(values: (string | number | null | undefined)[]): string {
  return values.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";");
}

/** True when a click landed on a form control or link, so a clickable row should not toggle. */
export function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest("input, select, textarea, button, a, label");
}
