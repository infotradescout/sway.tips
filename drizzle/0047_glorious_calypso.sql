ALTER TABLE "payments" ADD COLUMN "processor_fee_recovery" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_processor_fee_recovery_valid" CHECK ("payments"."processor_fee_recovery" >= 0);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_new_money_amount_shape" CHECK ("payments"."legacy_unlinked" or "payments"."amount_total" = "payments"."amount_subtotal" + "payments"."platform_fee" + "payments"."processor_fee_recovery");--> statement-breakpoint
CREATE TABLE "payout_processor_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"withdrawal_id" uuid,
	"payload_sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payment_mode" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_processor_events_provider_allowed" CHECK ("payout_processor_events"."provider" = 'paypal_payouts'),
	CONSTRAINT "payout_processor_events_payment_mode_allowed" CHECK ("payout_processor_events"."payment_mode" in ('test', 'live')),
	CONSTRAINT "payout_processor_events_status_allowed" CHECK ("payout_processor_events"."status" in ('pending', 'processed', 'ignored', 'failed')),
	CONSTRAINT "payout_processor_events_payload_hash_valid" CHECK ("payout_processor_events"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payout_processor_events_payload_valid" CHECK (jsonb_typeof("payout_processor_events"."payload") = 'object'),
	CONSTRAINT "payout_processor_events_processed_shape" CHECK (("payout_processor_events"."status" in ('processed', 'ignored') and "payout_processor_events"."processed_at" is not null) or ("payout_processor_events"."status" not in ('processed', 'ignored') and "payout_processor_events"."processed_at" is null))
);
--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" DROP CONSTRAINT "performer_payout_preferences_destination_kind_allowed";--> statement-breakpoint
ALTER TABLE "performer_withdrawals" DROP CONSTRAINT "performer_withdrawals_destination_allowed";--> statement-breakpoint
ALTER TABLE "performer_withdrawals" DROP CONSTRAINT "performer_withdrawals_speed_allowed";--> statement-breakpoint
ALTER TABLE "performer_withdrawals" DROP CONSTRAINT "performer_withdrawals_status_allowed";--> statement-breakpoint
INSERT INTO "audit_events" (
	"actor_type", "actor_id", "entity_type", "entity_id", "event_type",
	"previous_status", "next_status", "metadata"
)
SELECT
	'system', NULL, 'performer_payout_preference', "performer_id",
	'performer_payout_preference.legacy_selection_removed', "destination_kind", 'not_selected',
	jsonb_build_object(
		'reason', 'paypal_venmo_only_cutover_requires_verified_encrypted_recipient',
		'rawRecipientStoredInAudit', false
	)
FROM "performer_payout_preferences";--> statement-breakpoint
DELETE FROM "performer_payout_preferences";--> statement-breakpoint
INSERT INTO "audit_events" (
	"actor_type", "actor_id", "entity_type", "entity_id", "event_type",
	"previous_status", "next_status", "metadata"
)
SELECT
	'system', NULL, 'performer_withdrawal', "id",
	'performer_withdrawal.legacy_simulation_removed', "status", 'removed',
	jsonb_build_object(
		'reason', 'unreleased_simulator_replaced_by_paypal_payouts',
		'paymentMode', 'test'
	)
FROM "performer_withdrawals";--> statement-breakpoint
DELETE FROM "performer_withdrawals";--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ALTER COLUMN "delivery_speed" SET DEFAULT 'provider';--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ALTER COLUMN "provider" SET DEFAULT 'paypal_payouts';--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ALTER COLUMN "provider" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD COLUMN "recipient_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD COLUMN "recipient_value_encrypted" text NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD COLUMN "recipient_value_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD COLUMN "recipient_value_preview" text NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD COLUMN "provider" text DEFAULT 'paypal_payouts' NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "recipient_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "recipient_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "recipient_preview" text NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "payment_mode" text NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "provider_sender_item_id" text;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "provider_item_id" text;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "provider_transaction_id" text;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "actual_provider_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD COLUMN "returned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payout_processor_events" ADD CONSTRAINT "payout_processor_events_withdrawal_id_performer_withdrawals_id_fk" FOREIGN KEY ("withdrawal_id") REFERENCES "public"."performer_withdrawals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_processor_events_provider_event_idx" ON "payout_processor_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "payout_processor_events_withdrawal_idx" ON "payout_processor_events" USING btree ("withdrawal_id","created_at");--> statement-breakpoint
CREATE INDEX "payout_processor_events_status_idx" ON "payout_processor_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_withdrawals_provider_item_idx" ON "performer_withdrawals" USING btree ("provider","provider_item_id") WHERE "performer_withdrawals"."provider_item_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "performer_withdrawals_provider_sender_item_idx" ON "performer_withdrawals" USING btree ("provider","provider_sender_item_id") WHERE "performer_withdrawals"."provider_sender_item_id" is not null;--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD CONSTRAINT "performer_payout_preferences_recipient_type_allowed" CHECK (("performer_payout_preferences"."destination_kind" = 'paypal' and "performer_payout_preferences"."recipient_type" = 'email')
      or ("performer_payout_preferences"."destination_kind" = 'venmo' and "performer_payout_preferences"."recipient_type" in ('email', 'phone', 'user_handle')));--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD CONSTRAINT "performer_payout_preferences_fingerprint_valid" CHECK ("performer_payout_preferences"."recipient_value_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD CONSTRAINT "performer_payout_preferences_encrypted_value_valid" CHECK (length("performer_payout_preferences"."recipient_value_encrypted") >= 32 and "performer_payout_preferences"."recipient_value_encrypted" like 'v1.%');--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD CONSTRAINT "performer_payout_preferences_preview_valid" CHECK (length(trim("performer_payout_preferences"."recipient_value_preview")) between 3 and 320);--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD CONSTRAINT "performer_payout_preferences_provider_allowed" CHECK ("performer_payout_preferences"."provider" = 'paypal_payouts');--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD CONSTRAINT "performer_payout_preferences_destination_kind_allowed" CHECK ("performer_payout_preferences"."destination_kind" in ('paypal', 'venmo'));--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_recipient_type_allowed" CHECK (("performer_withdrawals"."destination_kind" = 'paypal' and "performer_withdrawals"."recipient_type" = 'email') or ("performer_withdrawals"."destination_kind" = 'venmo' and "performer_withdrawals"."recipient_type" in ('email', 'phone', 'user_handle')));--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_recipient_fingerprint_valid" CHECK ("performer_withdrawals"."recipient_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_payment_mode_allowed" CHECK ("performer_withdrawals"."payment_mode" in ('test', 'live'));--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_actual_fee_valid" CHECK ("performer_withdrawals"."actual_provider_fee_cents" is null or "performer_withdrawals"."actual_provider_fee_cents" >= 0);--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_provider_allowed" CHECK ("performer_withdrawals"."provider" = 'paypal_payouts');--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_lease_shape" CHECK (("performer_withdrawals"."status" = 'submitting' and "performer_withdrawals"."lease_owner" is not null and "performer_withdrawals"."lease_expires_at" is not null) or ("performer_withdrawals"."status" <> 'submitting' and "performer_withdrawals"."lease_owner" is null and "performer_withdrawals"."lease_expires_at" is null));--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_attempt_count_valid" CHECK ("performer_withdrawals"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_returned_shape" CHECK (("performer_withdrawals"."status" = 'returned' and "performer_withdrawals"."returned_at" is not null) or ("performer_withdrawals"."status" <> 'returned' and "performer_withdrawals"."returned_at" is null));--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_destination_allowed" CHECK ("performer_withdrawals"."destination_kind" in ('paypal', 'venmo'));--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_speed_allowed" CHECK ("performer_withdrawals"."delivery_speed" = 'provider');--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_status_allowed" CHECK ("performer_withdrawals"."status" in ('requested', 'submitting', 'processing', 'unclaimed', 'held', 'paid', 'failed', 'returned', 'canceled'));--> statement-breakpoint
CREATE FUNCTION "sway_lock_payout_recipient_during_withdrawal"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "performer_withdrawals"
    WHERE "performer_id" = OLD."performer_id"
      AND "status" in ('requested', 'submitting', 'processing', 'unclaimed', 'held')
  ) THEN
    RAISE EXCEPTION 'payout recipient locked while withdrawal is unresolved'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "performer_payout_preferences_unresolved_withdrawal_guard"
BEFORE UPDATE OR DELETE ON "performer_payout_preferences"
FOR EACH ROW EXECUTE FUNCTION "sway_lock_payout_recipient_during_withdrawal"();
