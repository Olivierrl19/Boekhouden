-- Database-level invariants (PLAN.md §3.3). These hold no matter which code writes to the DB.
-- Every statement is separated by a drizzle statement-breakpoint.

-- I-fy: fiscal years never overlap.
ALTER TABLE fiscal_years ADD CONSTRAINT fiscal_years_no_overlap
  EXCLUDE USING gist (daterange(start_date, end_date, '[]') WITH &&);
--> statement-breakpoint

-- I2: immutable tables. Any UPDATE or DELETE is refused.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Tabel % is onveranderlijk: % is niet toegestaan (gebruik een tegenboeking)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER bank_transactions_immutable BEFORE UPDATE OR DELETE ON bank_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint

-- I3: entries only in an open fiscal year (closing: only year-end templates), date inside the year.
CREATE FUNCTION check_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fy fiscal_years%ROWTYPE;
BEGIN
  SELECT * INTO fy FROM fiscal_years WHERE id = NEW.fiscal_year_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Onbekend boekjaar';
  END IF;
  IF NEW.entry_date < fy.start_date OR NEW.entry_date > fy.end_date THEN
    RAISE EXCEPTION 'Boekdatum % valt buiten boekjaar %', NEW.entry_date, fy.label;
  END IF;
  IF fy.status = 'closed' THEN
    RAISE EXCEPTION 'Boekjaar % is afgesloten', fy.label;
  END IF;
  IF fy.status = 'closing' AND NEW.template NOT IN ('T25', 'T25b', 'T27') THEN
    RAISE EXCEPTION 'Boekjaar % is in afsluiting: alleen afsluitboekingen toegestaan', fy.label;
  END IF;
  IF NEW.template IN ('T29', 'T23', 'T27', 'T28') AND coalesce(btrim(NEW.reason), '') = '' THEN
    RAISE EXCEPTION 'Reden is verplicht voor boeking van type %', NEW.template;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_check BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_journal_entry();
--> statement-breakpoint

-- I4, I5, I10 and bank rules, per line.
CREATE FUNCTION check_journal_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  acc ledger_accounts%ROWTYPE;
  entry journal_entries%ROWTYPE;
  p parties%ROWTYPE;
  act activities%ROWTYPE;
  bank bank_accounts%ROWTYPE;
  btx bank_transactions%ROWTYPE;
BEGIN
  SELECT * INTO acc FROM ledger_accounts WHERE id = NEW.account_id;
  SELECT * INTO entry FROM journal_entries WHERE id = NEW.entry_id;

  IF NOT acc.active THEN
    RAISE EXCEPTION 'Rekening % is niet actief', acc.code;
  END IF;

  -- Pot: required on income/expense, forbidden on balance sheet accounts.
  IF acc.type IN ('income', 'expense') AND NEW.pot_id IS NULL THEN
    RAISE EXCEPTION 'Rekening % vereist een potje', acc.code;
  END IF;
  IF acc.type NOT IN ('income', 'expense') AND NEW.pot_id IS NOT NULL THEN
    RAISE EXCEPTION 'Rekening % is een balansrekening en mag geen potje hebben', acc.code;
  END IF;

  -- Party: required (with the right kind) on person accounts, forbidden elsewhere.
  IF acc.requires_party THEN
    IF NEW.party_id IS NULL THEN
      RAISE EXCEPTION 'Rekening % vereist een persoon', acc.code;
    END IF;
    SELECT * INTO p FROM parties WHERE id = NEW.party_id;
    IF p.kind <> acc.party_kind THEN
      RAISE EXCEPTION 'Rekening % is voor % en niet voor %', acc.code, acc.party_kind, p.kind;
    END IF;
  ELSIF NEW.party_id IS NOT NULL THEN
    RAISE EXCEPTION 'Rekening % mag geen persoon hebben', acc.code;
  END IF;

  -- Activity: required on "nog te verdelen"; a settled activity takes no new lines.
  IF acc.requires_activity AND NEW.activity_id IS NULL THEN
    RAISE EXCEPTION 'Rekening % vereist een activiteit', acc.code;
  END IF;
  IF NEW.activity_id IS NOT NULL THEN
    SELECT * INTO act FROM activities WHERE id = NEW.activity_id;
    IF act.status <> 'open' THEN
      RAISE EXCEPTION 'Activiteit "%" is afgerekend; heropen de activiteit eerst', act.name;
    END IF;
  END IF;

  -- Manual (memorial) entries may not touch system-controlled accounts.
  IF entry.template IN ('T29', 'T23') AND NOT acc.manual_posting_allowed THEN
    RAISE EXCEPTION 'Op rekening % kan niet handmatig worden geboekt', acc.code;
  END IF;

  -- Suspense account lines always belong to a bank transaction.
  IF acc.system_key = 'BANK_SUSPENSE' AND NEW.bank_transaction_id IS NULL THEN
    RAISE EXCEPTION 'Rekening % kan alleen via een banktransactie worden geboekt', acc.code;
  END IF;

  -- Bank/cash ledger accounts: only through their own bank transaction (exactly once, same amount),
  -- except the opening balance (T26), a cash count difference on a cash account (T20),
  -- and reversals of those.
  SELECT * INTO bank FROM bank_accounts WHERE ledger_account_id = acc.id;
  IF FOUND THEN
    IF NEW.bank_transaction_id IS NULL THEN
      IF NOT (entry.template = 'T26'
              OR (entry.template = 'T20' AND bank.kind = 'cash')
              OR (entry.template = 'T27' AND EXISTS (
                    SELECT 1 FROM journal_entries o
                    WHERE o.id = entry.reverses_entry_id AND o.template IN ('T26', 'T20')))) THEN
        RAISE EXCEPTION 'Rekening % kan alleen via een banktransactie worden geboekt', acc.code;
      END IF;
    ELSE
      SELECT * INTO btx FROM bank_transactions WHERE id = NEW.bank_transaction_id;
      IF btx.bank_account_id <> bank.id THEN
        RAISE EXCEPTION 'Banktransactie hoort niet bij rekening %', acc.code;
      END IF;
      IF NEW.amount_cents <> btx.amount_cents THEN
        RAISE EXCEPTION 'Bedrag op bankrekening wijkt af van de banktransactie';
      END IF;
      IF EXISTS (SELECT 1 FROM journal_lines l
                 WHERE l.bank_transaction_id = NEW.bank_transaction_id AND l.account_id = acc.id) THEN
        RAISE EXCEPTION 'Banktransactie is al op de bankrekening geboekt';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_check BEFORE INSERT ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION check_journal_line();
--> statement-breakpoint

-- I1: every entry balances to zero and has at least two lines. Checked at commit time.
CREATE FUNCTION check_entry_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  total numeric;
  n integer;
BEGIN
  IF TG_TABLE_NAME = 'journal_entries' THEN
    target := NEW.id;
  ELSE
    target := NEW.entry_id;
  END IF;
  SELECT coalesce(sum(amount_cents), 0), count(*) INTO total, n
    FROM journal_lines WHERE entry_id = target;
  IF n < 2 THEN
    RAISE EXCEPTION 'Journaalpost % heeft minder dan twee regels', target;
  END IF;
  IF total <> 0 THEN
    RAISE EXCEPTION 'Journaalpost % sluit niet (verschil % cent)', target, total;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON journal_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_balanced();
--> statement-breakpoint

-- A reversal must mirror an existing entry, and an entry can be reversed only once
-- (the latter via the UNIQUE constraint on reverses_entry_id).
CREATE FUNCTION check_reversal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reverses_entry_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.reverses_entry_id) THEN
      RAISE EXCEPTION 'Tegen te boeken journaalpost bestaat niet';
    END IF;
    IF EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.reverses_entry_id AND reverses_entry_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Een tegenboeking kan niet zelf worden tegengeboekt; boek opnieuw';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_reversal BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION check_reversal();
--> statement-breakpoint

-- I10: an activity can only be marked settled when nothing is left to distribute.
CREATE FUNCTION check_activity_settled() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  remaining numeric;
BEGIN
  IF NEW.status = 'settled' AND OLD.status <> 'settled' THEN
    SELECT coalesce(sum(l.amount_cents), 0) INTO remaining
      FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
     WHERE l.activity_id = NEW.id AND a.system_key = 'TO_DISTRIBUTE';
    IF remaining <> 0 THEN
      RAISE EXCEPTION 'Activiteit "%" heeft nog % cent te verdelen', NEW.name, remaining;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER activities_settled_check BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION check_activity_settled();
--> statement-breakpoint

-- I11: hash chain on the audit log. Serialised with an advisory lock so concurrent
-- inserts cannot fork the chain.
CREATE FUNCTION audit_log_hash() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous text;
BEGIN
  PERFORM pg_advisory_xact_lock(727274);
  SELECT hash INTO previous FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.prev_hash := previous;
  NEW.hash := encode(sha256(convert_to(coalesce(previous, '') || audit_log_payload(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION audit_log_payload(r audit_log) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'id', r.id,
    'occurred_at', to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor', r.actor_user_id,
    'action', r.action,
    'entity_type', r.entity_type,
    'entity_id', r.entity_id,
    'data', r.data,
    'reason', r.reason
  )::text;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_hash BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_hash();
--> statement-breakpoint

-- Verify the whole chain; returns the id of the first broken row, or NULL when intact.
CREATE FUNCTION audit_log_verify() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log%ROWTYPE;
  previous text := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM previous
       OR r.hash <> encode(sha256(convert_to(coalesce(previous, '') || audit_log_payload(r), 'UTF8')), 'hex') THEN
      RETURN r.id;
    END IF;
    previous := r.hash;
  END LOOP;
  RETURN NULL;
END;
$$;
