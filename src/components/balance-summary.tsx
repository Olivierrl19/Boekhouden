import { formatEuro, type Cents } from "@/domain/money";

export function BalanceSummary({ balance, iban, accountName }: { balance: Cents; iban?: string | null; accountName?: string | null }) {
  if (balance > 0) {
    return (
      <p>
        Openstaand: <strong className="text-red-700 dark:text-red-400">{formatEuro(balance)}</strong>
        {iban && (
          <>
            . Maak dit over naar <strong>{iban}</strong>
            {accountName && <> t.n.v. {accountName}</>} o.v.v. je naam.
          </>
        )}
      </p>
    );
  }
  if (balance < 0) {
    return (
      <p>
        Je hebt een tegoed van <strong className="text-emerald-700 dark:text-emerald-400">{formatEuro((-balance) as Cents)}</strong>.
      </p>
    );
  }
  return <p>Je staat precies op nul. 🎉</p>;
}
