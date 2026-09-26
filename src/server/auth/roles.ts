/**
 * Roles are assigned per fiscal year (so a board handover is one action). Being a member is
 * implicit: a user linked to a member party can see their own account and claims.
 *
 * Capabilities (PLAN.md §10):
 *  - viewAll:  fiscus, bestuur, kascommissie
 *  - edit:     fiscus, bestuur            (bank, activities, invoices, members)
 *  - approve:  fiscus                     (claims, final settlements)
 *  - admin:    fiscus                     (memorial, reversals, year end, settings, roles)
 * The kascommissie never gets write capabilities.
 */
import { cache } from "react";
import { redirect } from "next/navigation";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { auth } from "@/auth";
import { getDb, schema } from "../db";
import { todayAmsterdam } from "@/domain/dates";
import type { Actor } from "../ledger/post";

export type Role = (typeof schema.roleName.enumValues)[number];
export type Capability = "viewAll" | "edit" | "approve" | "admin";

const CAPABILITIES: Record<Capability, Role[]> = {
  viewAll: ["fiscus", "bestuur", "kascommissie"],
  edit: ["fiscus", "bestuur"],
  approve: ["fiscus"],
  admin: ["fiscus"],
};

export class AccessDenied extends Error {
  constructor(message = "Je hebt geen toegang tot deze actie") {
    super(message);
    this.name = "AccessDenied";
  }
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  partyId: string | null;
}

export interface Access {
  user: CurrentUser;
  fiscalYear: typeof schema.fiscalYears.$inferSelect | null;
  roles: Set<Role>;
  isMember: boolean;
  can: (capability: Capability) => boolean;
  actor: Actor;
}

/** The fiscal year containing today, or the most recent one. */
export const currentFiscalYear = cache(async () => {
  const db = getDb();
  const today = todayAmsterdam();
  const [current] = await db
    .select()
    .from(schema.fiscalYears)
    .where(and(lte(schema.fiscalYears.startDate, today), gte(schema.fiscalYears.endDate, today)));
  if (current) return current;
  const [latest] = await db.select().from(schema.fiscalYears).orderBy(desc(schema.fiscalYears.startDate)).limit(1);
  return latest ?? null;
});

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;
  const [user] = await getDb().select().from(schema.users).where(eq(schema.users.id, id));
  if (!user?.email) return null;
  return { id: user.id, email: user.email, name: user.name, partyId: user.partyId };
});

export async function rolesFor(userId: string, fiscalYearId: string): Promise<Set<Role>> {
  const rows = await getDb()
    .select({ role: schema.roleAssignments.role })
    .from(schema.roleAssignments)
    .where(and(eq(schema.roleAssignments.userId, userId), eq(schema.roleAssignments.fiscalYearId, fiscalYearId)));
  return new Set(rows.map((r) => r.role));
}

export function hasCapability(roles: Set<Role>, capability: Capability): boolean {
  return CAPABILITIES[capability].some((r) => roles.has(r));
}

async function buildAccess(user: CurrentUser, fiscalYearId?: string): Promise<Access> {
  let fiscalYear = await currentFiscalYear();
  if (fiscalYearId && fiscalYearId !== fiscalYear?.id) {
    const [fy] = await getDb().select().from(schema.fiscalYears).where(eq(schema.fiscalYears.id, fiscalYearId));
    fiscalYear = fy ?? null;
  }
  const roles = fiscalYear ? await rolesFor(user.id, fiscalYear.id) : new Set<Role>();
  let isMember = false;
  if (user.partyId) {
    const [m] = await getDb().select().from(schema.members).where(eq(schema.members.partyId, user.partyId));
    isMember = !!m;
  }
  return {
    user,
    fiscalYear,
    roles,
    isMember,
    can: (c) => hasCapability(roles, c),
    actor: { userId: user.id },
  };
}

/** For pages: redirect to /login when not signed in. */
export const requireUser = cache(async (fiscalYearId?: string): Promise<Access> => {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return buildAccess(user, fiscalYearId);
});

/** For pages: require a capability, otherwise send members to their own page. */
export async function requireCapability(capability: Capability, fiscalYearId?: string): Promise<Access> {
  const access = await requireUser(fiscalYearId);
  if (!access.can(capability)) redirect("/mijn");
  return access;
}

/** For server actions: throw instead of redirecting. */
export async function authorize(capability: Capability, fiscalYearId?: string): Promise<Access> {
  const user = await getCurrentUser();
  if (!user) throw new AccessDenied("Je bent niet ingelogd");
  const access = await buildAccess(user, fiscalYearId);
  if (!access.can(capability)) throw new AccessDenied();
  return access;
}
