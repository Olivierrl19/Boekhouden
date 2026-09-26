"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Home, Landmark, ListChecks, PartyPopper, User, Users, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";

const ICONS = { Home, Landmark, Wallet, Users, PartyPopper, BookOpen, ListChecks, User };
export type NavIcon = keyof typeof ICONS;
export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  badge?: number;
}

export function Nav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              active && "bg-accent font-medium text-foreground",
            )}
          >
            <Icon className="size-4" />
            <span className="flex-1">{item.label}</span>
            {!!item.badge && (
              <span className="rounded-full bg-amber-500 px-2 text-xs font-semibold text-white">{item.badge}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
