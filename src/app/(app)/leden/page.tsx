import Link from "next/link";
import { requireCapability } from "@/server/auth/roles";
import { memberList } from "@/server/queries/overview";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";

export default async function MembersPage() {
  await requireCapability("viewAll");
  const members = await memberList();
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Leden" description={`${members.filter((m) => !m.leftOn).length} actieve leden`} />
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Naam</TableHead>
                <TableHead>Jaargang</TableHead>
                <TableHead>Soort lid</TableHead>
                <TableHead className="text-right">Contributie / mnd</TableHead>
                <TableHead className="text-right">Saldo</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.partyId}>
                  <TableCell>
                    <Link href={`/debiteuren/${m.partyId}`} className="hover:underline">{m.name}</Link>
                    {m.leftOn && <Badge variant="outline" className="ml-2">uitgeschreven</Badge>}
                    <div className="text-xs text-muted-foreground">{m.email ?? "geen e-mail (kan niet inloggen)"}</div>
                  </TableCell>
                  <TableCell>{m.cohort ?? "—"}</TableCell>
                  <TableCell><Badge variant="secondary">{m.typeName}</Badge></TableCell>
                  <TableCell className="text-right"><Money value={m.monthly} /></TableCell>
                  <TableCell className="text-right"><Money value={m.balance} tone /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
