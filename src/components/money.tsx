import { cn } from "@/lib/utils";
import { formatEuro, type Cents } from "@/domain/money";

/** Amount in euros, right-aligned with tabular digits. `tone` colours positive/negative. */
export function Money({ value, tone = false, className }: { value: Cents | number; tone?: boolean; className?: string }) {
  const v = value as Cents;
  return (
    <span
      className={cn(
        "tabular-nums whitespace-nowrap",
        tone && v < 0 && "text-emerald-700 dark:text-emerald-400",
        tone && v > 0 && "text-red-700 dark:text-red-400",
        className,
      )}
    >
      {formatEuro(v)}
    </span>
  );
}
