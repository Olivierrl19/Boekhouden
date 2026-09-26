import Link from "next/link";
import { cn } from "@/lib/utils";

export function YearSelect({ years, current, basePath }: { years: { label: string; status: string }[]; current: string; basePath: string }) {
  return (
    <div className="flex flex-wrap gap-1">
      {years.map((y) => (
        <Link
          key={y.label}
          href={`${basePath}?jaar=${y.label}`}
          className={cn(
            "rounded-md border px-3 py-1 text-sm",
            y.label === current ? "bg-primary text-primary-foreground" : "hover:bg-accent",
          )}
        >
          {y.label}
          {y.status === "closed" && " 🔒"}
        </Link>
      ))}
    </div>
  );
}
