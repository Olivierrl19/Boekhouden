import { requireUser } from "@/server/auth/roles";
import { personStatement } from "@/server/queries/overview";
import { getSettings } from "@/server/services/setup";
import { getDb } from "@/server/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { StatementTable } from "@/components/statement-table";
import { BalanceSummary } from "@/components/balance-summary";

export default async function MyAccountPage() {
  const access = await requireUser();
  if (!access.user.partyId) {
    return <p className="text-sm text-muted-foreground">Je account is niet gekoppeld aan een lid.</p>;
  }
  const statement = await personStatement(access.user.partyId);
  const settings = await getSettings(getDb());
  if (!statement) return null;
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Mijn rekening" description={statement.party.name} />
      <Card>
        <CardContent className="p-5">
          <BalanceSummary balance={statement.balance} iban={settings?.paymentIban} accountName={settings?.paymentAccountName} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Mutaties</CardTitle>
        </CardHeader>
        <CardContent>
          <StatementTable lines={statement.lines} />
        </CardContent>
      </Card>
    </div>
  );
}
