import { requireCapability } from "@/server/auth/roles";
import { chartWithBalances, fiscalYears } from "@/server/queries/overview";
import { yearFromParam } from "@/server/queries/years";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { YearSelect } from "@/components/year-select";
import { sum } from "@/domain/money";

const GROUPS = [
  { title: "Balans", types: ["asset", "liability", "equity"] },
  { title: "Resultaat", types: ["income", "expense"] },
] as const;

export default async function ChartPage({ searchParams }: PageProps<"/rekeningschema">) {
  const params = await searchParams;
  const fy = await yearFromParam(params.jaar);
  await requireCapability("viewAll", fy?.id);
  if (!fy) return null;
  const { balances } = await chartWithBalances(fy);
  const years = await fiscalYears();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Rekeningschema"
        description={`Saldi per ${fy.label}: balansrekeningen t/m einde boekjaar, resultaatrekeningen over het boekjaar. Debet positief.`}
      >
        <YearSelect years={years} current={fy.label} basePath="/rekeningschema" />
      </PageHeader>
      {GROUPS.map((g) => {
        const rows = balances.filter((b) => (g.types as readonly string[]).includes(b.type));
        return (
          <Card key={g.title}>
            <CardHeader>
              <CardTitle>{g.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Code</TableHead>
                    <TableHead>Naam</TableHead>
                    <TableHead className="text-right">Saldo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.accountId}>
                      <TableCell className="font-mono text-xs">{r.code}</TableCell>
                      <TableCell>{r.name}</TableCell>
                      <TableCell className="text-right"><Money value={r.balance} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2}>{g.title === "Balans" ? "Totaal (= −resultaat lopend jaar)" : "Totaal (negatief = winst)"}</TableCell>
                    <TableCell className="text-right"><Money value={sum(rows.map((r) => r.balance))} /></TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
