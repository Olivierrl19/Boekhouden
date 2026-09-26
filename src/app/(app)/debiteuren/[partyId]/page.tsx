import { notFound } from "next/navigation";
import { requireCapability } from "@/server/auth/roles";
import { personStatement } from "@/server/queries/overview";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { StatementTable } from "@/components/statement-table";
import { Money } from "@/components/money";

export default async function PersonPage({ params }: PageProps<"/debiteuren/[partyId]">) {
  await requireCapability("viewAll");
  const { partyId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(partyId)) notFound();
  const statement = await personStatement(partyId);
  if (!statement) notFound();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={statement.party.name} description={statement.party.kind === "member" ? "Lid" : "Extern"}>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Saldo</div>
          <div className="text-2xl font-semibold"><Money value={statement.balance} tone /></div>
        </div>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>Rekening</CardTitle>
        </CardHeader>
        <CardContent>
          <StatementTable lines={statement.lines} />
        </CardContent>
      </Card>
    </div>
  );
}
