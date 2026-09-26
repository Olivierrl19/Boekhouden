import { requireCapability } from "@/server/auth/roles";
import { getDb, schema } from "@/server/db";
import { openActivityBalances } from "@/server/ledger/balances";
import { desc, eq } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { formatDateNl, localDate } from "@/domain/dates";

export default async function ActivitiesPage() {
  await requireCapability("viewAll");
  const db = getDb();
  const open = await openActivityBalances(db);
  const settled = await db
    .select({ id: schema.activities.id, name: schema.activities.name, heldOn: schema.activities.heldOn, pot: schema.pots.name })
    .from(schema.activities)
    .innerJoin(schema.pots, eq(schema.pots.id, schema.activities.potId))
    .where(eq(schema.activities.status, "settled"))
    .orderBy(desc(schema.activities.heldOn))
    .limit(30);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Activiteiten" description="Uitgaven voor een activiteit staan op 'nog te verdelen' tot de activiteit wordt afgerekend." />
      <Card>
        <CardHeader><CardTitle>Open</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Activiteit</TableHead>
                <TableHead>Datum</TableHead>
                <TableHead className="text-right">Nog te verdelen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {open.map((a) => (
                <TableRow key={a.activityId}>
                  <TableCell>{a.name}</TableCell>
                  <TableCell>{a.heldOn ? formatDateNl(localDate(a.heldOn)) : "—"}</TableCell>
                  <TableCell className="text-right"><Money value={a.balance} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Afgerekend (laatste 30)</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableBody>
              {settled.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>{a.name}</TableCell>
                  <TableCell>{a.heldOn ? formatDateNl(localDate(a.heldOn)) : "—"}</TableCell>
                  <TableCell><Badge variant="secondary">{a.pot}</Badge></TableCell>
                  <TableCell className="text-right"><Badge variant="success">afgerekend</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
