import Link from "next/link";
import { requireCapability } from "@/server/auth/roles";
import { fiscalYears, journalPage } from "@/server/queries/overview";
import { yearFromParam } from "@/server/queries/years";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Money } from "@/components/money";
import { PageHeader } from "@/components/page-header";
import { YearSelect } from "@/components/year-select";
import { TEMPLATE_CODES, type TemplateCode } from "@/domain/ledger/types";
import { formatDateNl, localDate } from "@/domain/dates";

const PAGE_SIZE = 50;

export default async function JournalPage({ searchParams }: PageProps<"/journaal">) {
  const params = await searchParams;
  const fy = await yearFromParam(params.jaar);
  await requireCapability("viewAll", fy?.id);
  if (!fy) return null;
  const page = Math.max(1, Number(params.pagina ?? 1) || 1);
  const { entries, total } = await journalPage(fy.id, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const years = await fiscalYears();
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Journaal" description={`${total} journaalposten in ${fy.label}. Debet positief, credit negatief.`}>
        <YearSelect years={years} current={fy.label} basePath="/journaal" />
      </PageHeader>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nummer / datum</TableHead>
                <TableHead>Omschrijving</TableHead>
                <TableHead>Rekening</TableHead>
                <TableHead className="text-right">Debet</TableHead>
                <TableHead className="text-right">Credit</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) =>
                e.lines.map((l, i) => (
                  <TableRow key={`${e.id}-${l.lineNo}`} className={i === 0 ? "border-t-2" : "border-0"}>
                    <TableCell className="align-top whitespace-nowrap">
                      {i === 0 && (
                        <>
                          <div className="font-mono text-xs">{e.entryNumber}</div>
                          <div className="text-xs text-muted-foreground">{formatDateNl(localDate(e.entryDate))}</div>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      {i === 0 && (
                        <>
                          <div>{e.description}</div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <Badge variant="outline">{e.template} · {TEMPLATE_CODES[e.template as TemplateCode] ?? e.template}</Badge>
                            {e.isAutomatic && <Badge variant="secondary">automatisch</Badge>}
                            {e.reversesEntryId && <Badge variant="warning">tegenboeking</Badge>}
                          </div>
                          {e.reason && <div className="mt-1 text-xs text-muted-foreground">Reden: {e.reason}</div>}
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-xs">{l.accountCode}</span> {l.accountName}
                      <div className="text-xs text-muted-foreground">
                        {[l.partyName, l.potName && `potje ${l.potName}`, l.activityName, l.description].filter(Boolean).join(" · ")}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{l.amount > 0 && <Money value={l.amount} />}</TableCell>
                    <TableCell className="text-right">{l.amount < 0 && <Money value={-l.amount} />}</TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <div className="flex items-center justify-between text-sm">
        <span>Pagina {page} van {pages}</span>
        <div className="flex gap-3">
          {page > 1 && <Link className="underline" href={`/journaal?jaar=${fy.label}&pagina=${page - 1}`}>Nieuwer</Link>}
          {page < pages && <Link className="underline" href={`/journaal?jaar=${fy.label}&pagina=${page + 1}`}>Ouder</Link>}
        </div>
      </div>
    </div>
  );
}
