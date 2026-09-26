import { desc, inArray } from "drizzle-orm";
import { requireCapability } from "@/server/auth/roles";
import { getDb, schema } from "@/server/db";
import { unassignedTransactionIds } from "@/server/ledger/balances";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { formatDateNl, localDate } from "@/domain/dates";

export default async function BankPage() {
  await requireCapability("viewAll");
  const db = getDb();
  const ids = await unassignedTransactionIds(db);
  const rows = ids.length
    ? await db
        .select()
        .from(schema.bankTransactions)
        .where(inArray(schema.bankTransactions.id, ids))
        .orderBy(desc(schema.bankTransactions.bookingDate))
    : [];
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Bank" description="Elke bankregel moet een plek krijgen: waar geboekt?" />
      <Card>
        <CardHeader>
          <CardTitle>Nog toe te wijzen ({rows.length})</CardTitle>
          <CardDescription>Importeren en toewijzen komen in de volgende bouwstappen (c en d).</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Datum</TableHead>
                <TableHead>Bij / af</TableHead>
                <TableHead className="text-right">Bedrag</TableHead>
                <TableHead>Tegenpartij</TableHead>
                <TableHead>Omschrijving</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="whitespace-nowrap">{formatDateNl(localDate(t.bookingDate))}</TableCell>
                  <TableCell>
                    <Badge variant={t.amountCents > 0 ? "success" : "destructive"}>{t.amountCents > 0 ? "bij" : "af"}</Badge>
                  </TableCell>
                  <TableCell className="text-right"><Money value={Math.abs(t.amountCents)} /></TableCell>
                  <TableCell>
                    {t.counterpartyName ?? "—"}
                    {t.counterpartyIban && <div className="font-mono text-xs text-muted-foreground">{t.counterpartyIban}</div>}
                  </TableCell>
                  <TableCell className="max-w-md truncate">{t.description}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
