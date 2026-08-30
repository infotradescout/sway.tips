CREATE TABLE "performer_payout_preferences" (
	"performer_id" uuid PRIMARY KEY NOT NULL,
	"destination_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_payout_preferences_destination_kind_allowed" CHECK ("performer_payout_preferences"."destination_kind" in ('bank_account', 'debit_card', 'cash_app_direct_deposit', 'venmo_direct_deposit'))
);
--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD CONSTRAINT "performer_payout_preferences_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;