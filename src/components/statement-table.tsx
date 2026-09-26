import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Money } from "@/components/money";
import { formatDateNl, localDate } from "@/domain/dates";
import type { Cents } from "@/domain/money";

export interface StatementLine {
  entryId: string;
  date: string;
  description: string;
  lineDescription: string | null;
  activityName: string | null;
  amount: Cents;
  balance: Cents;
}

/** A person's account: what the association advanced (+) and what they paid or declared (−). */
export function StatementTable({ lines }: { lines: StatementLine[] }) {
  if (lines.length === 0) return <p className="text-sm text-muted-foreground">Nog geen mutaties.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Datum</TableHead>
          <TableHead>Omschrijving</TableHead>
          <TableHead className="text-right">Voorgeschoten</TableHead>
          <TableHead className="text-right">Betaald / tegoed</TableHead>
          <TableHead className="text-right">Saldo</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...lines].reverse().map((l, i) => (
          <TableRow key={`${l.entryId}-${i}`}>
            <TableCell className="whitespace-nowrap">{formatDateNl(localDate(l.date))}</TableCell>
            <TableCell>
              {l.lineDescription ?? l.description}
              {l.activityName && <span className="text-muted-foreground"> · {l.activityName}</span>}
            </TableCell>
            <TableCell className="text-right">{l.amount > 0 && <Money value={l.amount} />}</TableCell>
            <TableCell className="text-right">{l.amount < 0 && <Money value={-l.amount} />}</TableCell>
            <TableCell className="text-right font-medium"><Money value={l.balance} tone /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
