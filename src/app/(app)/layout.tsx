import { signOut } from "@/auth";
import { requireUser } from "@/server/auth/roles";
import { orgName } from "@/server/queries/overview";
import { unassignedCount } from "@/server/ledger/balances";
import { getDb } from "@/server/db";
import { Nav, type NavItem } from "@/components/nav";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const ROLE_LABEL = { fiscus: "Fiscus", bestuur: "Bestuur", kascommissie: "Kascommissie" } as const;

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const access = await requireUser();
  const name = await orgName();
  const items: NavItem[] = [];
  if (access.can("viewAll")) {
    const open = await unassignedCount(getDb());
    items.push(
      { href: "/", label: "Overzicht", icon: "Home" },
      { href: "/bank", label: "Bank", icon: "Landmark", badge: open },
      { href: "/debiteuren", label: "Debiteurenlijst", icon: "Wallet" },
      { href: "/activiteiten", label: "Activiteiten", icon: "PartyPopper" },
      { href: "/leden", label: "Leden", icon: "Users" },
      { href: "/journaal", label: "Journaal", icon: "BookOpen" },
      { href: "/rekeningschema", label: "Rekeningschema", icon: "ListChecks" },
    );
  }
  if (access.user.partyId) items.push({ href: "/mijn", label: "Mijn rekening", icon: "User" });

  async function logout() {
    "use server";
    await signOut({ redirectTo: "/login" });
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="border-b bg-muted/30 p-4 md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="mb-6 px-3">
          <div className="font-semibold">{name}</div>
          <div className="text-xs text-muted-foreground">
            Boekjaar {access.fiscalYear?.label ?? "—"}
          </div>
        </div>
        <Nav items={items} />
        <div className="mt-8 border-t px-3 pt-4 text-xs text-muted-foreground">
          <div className="truncate">{access.user.email}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {[...access.roles].map((r) => (
              <Badge key={r} variant="secondary">
                {ROLE_LABEL[r]}
              </Badge>
            ))}
            {access.isMember && <Badge variant="outline">Lid</Badge>}
          </div>
          <form action={logout} className="mt-3">
            <Button variant="ghost" size="sm" className="-ml-3">
              Uitloggen
            </Button>
          </form>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
    </div>
  );
}
