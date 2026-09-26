/**
 * Database schema. See PLAN.md §3 for the data model and invariants.
 * Invariants that Drizzle cannot express (immutability, balanced entries, fiscal year rules)
 * live in drizzle/0001_invariants.sql.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AdapterAccountType } from "next-auth/adapters";

const money = (name: string) => bigint(name, { mode: "number" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const fiscalYearStatus = pgEnum("fiscal_year_status", ["open", "closing", "closed"]);
export const accountType = pgEnum("account_type", ["asset", "liability", "equity", "income", "expense"]);
export const partyKind = pgEnum("party_kind", ["member", "external"]);
export const budgetKind = pgEnum("budget_kind", ["income", "expense"]);
export const roleName = pgEnum("role_name", ["fiscus", "bestuur", "kascommissie"]);
export const bankAccountKind = pgEnum("bank_account_kind", ["checking", "savings", "cash"]);
export const activityStatus = pgEnum("activity_status", ["open", "settled"]);

// ---------------------------------------------------------------------------
// Organisation settings (singleton row, id = 1)
// ---------------------------------------------------------------------------

export const orgSettings = pgTable(
  "org_settings",
  {
    id: integer("id").primaryKey().default(1),
    name: text("name").notNull(),
    shortName: text("short_name").notNull(),
    paymentIban: text("payment_iban"),
    paymentAccountName: text("payment_account_name"),
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(8),
    statementDay: integer("statement_day").notNull().default(1),
    statementAutoSend: boolean("statement_auto_send").notNull().default(true),
    mailFrom: text("mail_from"),
    setupCompleted: boolean("setup_completed").notNull().default(false),
    isDemo: boolean("is_demo").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("org_settings_singleton", sql`${t.id} = 1`),
    check("org_settings_start_month", sql`${t.fiscalYearStartMonth} between 1 and 12`),
    check("org_settings_statement_day", sql`${t.statementDay} between 1 and 28`),
  ],
);

// ---------------------------------------------------------------------------
// Fiscal years
// ---------------------------------------------------------------------------

export const fiscalYears = pgTable(
  "fiscal_years",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    label: text("label").notNull().unique(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    status: fiscalYearStatus("status").notNull().default("open"),
    nextEntryNumber: integer("next_entry_number").notNull().default(1),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by"),
    createdAt: createdAt(),
  },
  (t) => [check("fiscal_years_dates", sql`${t.startDate} < ${t.endDate}`)],
);

// ---------------------------------------------------------------------------
// Chart of accounts and pots
// ---------------------------------------------------------------------------

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    type: accountType("type").notNull(),
    systemKey: text("system_key").unique(),
    requiresParty: boolean("requires_party").notNull().default(false),
    partyKind: partyKind("party_kind"),
    requiresActivity: boolean("requires_activity").notNull().default(false),
    manualPostingAllowed: boolean("manual_posting_allowed").notNull().default(true),
    defaultVatCode: text("default_vat_code"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    check("ledger_accounts_party_kind", sql`(${t.requiresParty} = (${t.partyKind} is not null))`),
    check("ledger_accounts_no_vat_yet", sql`${t.defaultVatCode} is null`),
  ],
);

export const pots = pgTable("pots", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  defaultIncomeAccountId: uuid("default_income_account_id").references(() => ledgerAccounts.id),
  defaultExpenseAccountId: uuid("default_expense_account_id").references(() => ledgerAccounts.id),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const budgetLines = pgTable(
  "budget_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fiscalYearId: uuid("fiscal_year_id").notNull().references(() => fiscalYears.id),
    potId: uuid("pot_id").notNull().references(() => pots.id),
    kind: budgetKind("kind").notNull(),
    amountCents: money("amount_cents").notNull(),
    note: text("note"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("budget_lines_unique").on(t.fiscalYearId, t.potId, t.kind),
    check("budget_lines_non_negative", sql`${t.amountCents} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Parties: members and externals
// ---------------------------------------------------------------------------

export const parties = pgTable("parties", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: partyKind("kind").notNull(),
  name: text("name").notNull(),
  email: text("email"),
  notes: text("notes"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const partyIbans = pgTable("party_ibans", {
  iban: text("iban").primaryKey(),
  partyId: uuid("party_id").notNull().references(() => parties.id),
  createdAt: createdAt(),
});

export const memberTypes = pgTable(
  "member_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    monthlyContributionCents: money("monthly_contribution_cents").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [check("member_types_non_negative", sql`${t.monthlyContributionCents} >= 0`)],
);

export const members = pgTable(
  "members",
  {
    partyId: uuid("party_id").primaryKey().references(() => parties.id),
    memberTypeId: uuid("member_type_id").notNull().references(() => memberTypes.id),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    cohort: integer("cohort"),
    joinedOn: date("joined_on").notNull(),
    leftOn: date("left_on"),
  },
  (t) => [check("members_dates", sql`${t.leftOn} is null or ${t.leftOn} >= ${t.joinedOn}`)],
);

// ---------------------------------------------------------------------------
// Auth.js tables (names/columns as expected by @auth/drizzle-adapter) + roles
// ---------------------------------------------------------------------------

export const users = pgTable("user", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
  partyId: uuid("party_id").references(() => parties.id).unique(),
});

export const authAccounts = pgTable(
  "account",
  {
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("session", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => users.id),
    fiscalYearId: uuid("fiscal_year_id").notNull().references(() => fiscalYears.id),
    role: roleName("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("role_assignments_unique").on(t.userId, t.fiscalYearId, t.role)],
);

// ---------------------------------------------------------------------------
// Activities (the "nog te verdelen" buckets)
// ---------------------------------------------------------------------------

export const activities = pgTable("activities", {
  id: uuid("id").primaryKey().defaultRandom(),
  fiscalYearId: uuid("fiscal_year_id").notNull().references(() => fiscalYears.id),
  name: text("name").notNull(),
  heldOn: date("held_on"),
  potId: uuid("pot_id").notNull().references(() => pots.id),
  description: text("description"),
  status: activityStatus("status").notNull().default("open"),
  settlementEntryId: uuid("settlement_entry_id"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Bank
// ---------------------------------------------------------------------------

export const bankAccounts = pgTable("bank_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  iban: text("iban").unique(),
  name: text("name").notNull(),
  kind: bankAccountKind("kind").notNull(),
  ledgerAccountId: uuid("ledger_account_id").notNull().unique().references(() => ledgerAccounts.id),
  importFormat: text("import_format"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const bankImports = pgTable("bank_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  format: text("format").notNull(),
  fileName: text("file_name").notNull(),
  fileSha256: text("file_sha256").notNull(),
  countNew: integer("count_new").notNull(),
  countDuplicate: integer("count_duplicate").notNull(),
  importedBy: text("imported_by").references(() => users.id),
  createdAt: createdAt(),
});

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankAccountId: uuid("bank_account_id").notNull().references(() => bankAccounts.id),
    externalId: text("external_id").notNull(),
    bookingDate: date("booking_date").notNull(),
    valueDate: date("value_date"),
    amountCents: money("amount_cents").notNull(),
    balanceAfterCents: money("balance_after_cents"),
    counterpartyIban: text("counterparty_iban"),
    counterpartyName: text("counterparty_name"),
    description: text("description").notNull().default(""),
    endToEndId: text("end_to_end_id"),
    paymentReference: text("payment_reference"),
    returnReason: text("return_reason"),
    raw: jsonb("raw"),
    importId: uuid("import_id").references(() => bankImports.id),
    enteredBy: text("entered_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("bank_transactions_idempotency").on(t.bankAccountId, t.externalId),
    index("bank_transactions_date").on(t.bankAccountId, t.bookingDate),
  ],
);

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fiscalYearId: uuid("fiscal_year_id").notNull().references(() => fiscalYears.id),
    entryNumber: text("entry_number").notNull().unique(),
    entryDate: date("entry_date").notNull(),
    template: text("template").notNull(),
    description: text("description").notNull(),
    sourceType: text("source_type"),
    sourceId: text("source_id"),
    reversesEntryId: uuid("reverses_entry_id").unique(),
    isAutomatic: boolean("is_automatic").notNull().default(false),
    autoReverse: boolean("auto_reverse").notNull().default(false),
    reason: text("reason"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("journal_entries_source").on(t.sourceType, t.sourceId),
    index("journal_entries_date").on(t.entryDate),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id").notNull().references(() => journalEntries.id),
    lineNo: integer("line_no").notNull(),
    accountId: uuid("account_id").notNull().references(() => ledgerAccounts.id),
    amountCents: money("amount_cents").notNull(),
    potId: uuid("pot_id").references(() => pots.id),
    activityId: uuid("activity_id").references(() => activities.id),
    partyId: uuid("party_id").references(() => parties.id),
    bankTransactionId: uuid("bank_transaction_id").references(() => bankTransactions.id),
    invoiceId: uuid("invoice_id"),
    description: text("description"),
    vatCode: text("vat_code"),
  },
  (t) => [
    uniqueIndex("journal_lines_entry_line").on(t.entryId, t.lineNo),
    index("journal_lines_account").on(t.accountId),
    index("journal_lines_party").on(t.partyId),
    index("journal_lines_activity").on(t.activityId),
    index("journal_lines_btx").on(t.bankTransactionId),
    check("journal_lines_non_zero", sql`${t.amountCents} <> 0`),
    check("journal_lines_no_vat_yet", sql`${t.vatCode} is null`),
  ],
);

// ---------------------------------------------------------------------------
// Audit log (append-only, hash chained by trigger)
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    data: jsonb("data").notNull().default({}),
    reason: text("reason"),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull().default(""),
  },
  (t) => [index("audit_log_entity").on(t.entityType, t.entityId)],
);

// ---------------------------------------------------------------------------
// Contribution (monthly, per member type)
// ---------------------------------------------------------------------------

export const contributionCharges = pgTable(
  "contribution_charges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    memberId: uuid("member_id").notNull().references(() => members.partyId),
    month: date("month").notNull(),
    amountCents: money("amount_cents").notNull(),
    entryId: uuid("entry_id").references(() => journalEntries.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("contribution_charges_member_month").on(t.memberId, t.month),
    check("contribution_charges_first_of_month", sql`extract(day from ${t.month}) = 1`),
    check("contribution_charges_positive", sql`${t.amountCents} > 0`),
  ],
);
