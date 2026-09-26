import { schema, type Tx } from "./db";

export interface AuditEvent {
  actorUserId: string | null;
  action: string; // e.g. "journal.post", "claim.approve"
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
  reason?: string | null;
}

/** Append to the audit log. The hash chain is computed by a DB trigger. */
export async function audit(tx: Tx, event: AuditEvent): Promise<void> {
  await tx.insert(schema.auditLog).values({
    actorUserId: event.actorUserId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    data: event.data ?? {},
    reason: event.reason ?? null,
  });
}
