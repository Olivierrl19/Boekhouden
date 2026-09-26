import Link from "next/link";
import { requireCapability } from "@/server/auth/roles";
import { debtorList } from "@/server/queries/overview";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { sum } from "@/domain/money";
import { formatDateNl, localDate } from "@/domain/dates";

export default async function DebtorListPage({ searchParams }: PageProps<"/debiteuren">) {
  await requireCapability("viewAll");
  const { alles } = await searchParams;
  const { persons, activities } = await debtorList();
  const shown = alles ? persons : persons.filter((p) => p.balance !== 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Debiteurenlijst"
        description="Wat iedereen het dispuut nog moet betalen (of tegoed heeft), en wat nog verdeeld moet worden."
      />
      <Card>
        <CardHeader>
          <CardTitle>Personen</CardTitle>
          <CardDescription>
            {alles ? (
              <Link href="/debiteuren" className="underline underline-offset-4">Alleen met saldo tonen</Link>
            ) : (
              <Link href="/debiteuren?alles=1" className="underline underline-offset-4">Ook personen met saldo € 0 tonen</Link>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Naam</TableHead>
                <TableHead>Soort</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((p) => (
                <TableRow key={p.partyId}>
                  <TableCell>
                    <Link href={`/debiteuren/${p.partyId}`} className="hover:underline">{p.name}</Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.kind === "member" ? "secondary" : "outline"}>{p.kind === "member" ? "Lid" : "Extern"}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={p.balance} tone />
                    <span className="ml-2 text-xs text-muted-foreground">{p.balance > 0 ? "moet betalen" : p.balance < 0 ? "tegoed" : ""}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={2}>Totaal te ontvangen / tegoeden</TableCell>
                <TableCell className="text-right">
                  <Money value={sum(persons.filter((p) => p.balance > 0).map((p) => p.balance))} /> /{" "}
                  <Money value={-sum(persons.filter((p) => p.balance < 0).map((p) => p.balance))} />
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nog te verdelen</CardTitle>
          <CardDescription>Uitgaven voor activiteiten die nog niet over de deelnemers zijn verdeeld.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Activiteit</TableHead>
                <TableHead>Datum</TableHead>
                <TableHead className="text-right">Te verdelen</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activities.map((a) => (
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
    </div>
  );
}
