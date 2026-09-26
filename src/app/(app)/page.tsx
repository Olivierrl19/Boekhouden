import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import { requireUser } from "@/server/auth/roles";
import { dashboardData } from "@/server/queries/overview";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { formatDateNl, localDate } from "@/domain/dates";

export default async function DashboardPage() {
  const access = await requireUser();
  if (!access.can("viewAll")) redirect("/mijn");
  if (!access.fiscalYear) return <p>Er is nog geen boekjaar aangemaakt.</p>;
  const d = await dashboardData(access.fiscalYear);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overzicht" description={`Boekjaar ${access.fiscalYear.label}`} />

      <Link href="/bank">
        {d.unassignedCount === 0 ? (
          <Card className="border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40">
            <CardContent className="flex items-center gap-3 p-5">
              <CheckCircle2 className="size-6 text-emerald-600" />
              <div>
                <div className="font-semibold">De boekhouding is bij</div>
                <div className="text-sm text-muted-foreground">Alle banktransacties zijn toegewezen.</div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
            <CardContent className="flex items-center gap-3 p-5">
              <AlertTriangle className="size-6 text-amber-600" />
              <div>
                <div className="font-semibold">
                  {d.unassignedCount} {d.unassignedCount === 1 ? "transactie" : "transacties"} nog toe te wijzen
                </div>
                <div className="text-sm text-muted-foreground">Geef elke bankregel een plek. Nul betekent: de boekhouding is bij.</div>
              </div>
            </CardContent>
          </Card>
        )}
      </Link>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {d.bankBalances.map((b) => (
          <Card key={b.id}>
            <CardHeader>
              <CardDescription>{b.name}</CardDescription>
              <CardTitle className="text-2xl">
                <Money value={b.balance} />
              </CardTitle>
              <CardDescription className="text-xs">
                {b.iban ?? "Kas"}
                {b.lastDate && ` · bijgewerkt t/m ${formatDateNl(localDate(b.lastDate))}`}
              </CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Nog te ontvangen van personen</CardDescription>
            <CardTitle className="text-xl"><Money value={d.receivable} /></CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Tegoeden van personen</CardDescription>
            <CardTitle className="text-xl"><Money value={-d.credit} /></CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Nog te verdelen ({d.openActivities} activiteiten)</CardDescription>
            <CardTitle className="text-xl"><Money value={d.toDistribute} /></CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Resultaat dit boekjaar</CardDescription>
            <CardTitle className="text-xl"><Money value={d.result} /></CardTitle>
          </CardHeader>
        </Card>
      </div>
    </div>
  );
}
