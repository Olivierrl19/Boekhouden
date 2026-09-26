CREATE TABLE "contribution_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_id" uuid NOT NULL,
	"month" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_charges_first_of_month" CHECK (extract(day from "contribution_charges"."month") = 1),
	CONSTRAINT "contribution_charges_positive" CHECK ("contribution_charges"."amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "contribution_charges" ADD CONSTRAINT "contribution_charges_member_id_members_party_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("party_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_charges" ADD CONSTRAINT "contribution_charges_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contribution_charges_member_month" ON "contribution_charges" USING btree ("member_id","month");