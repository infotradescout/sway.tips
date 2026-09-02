ALTER TABLE "performer_payout_preferences" ADD COLUMN "payment_mode" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD CONSTRAINT "performer_payout_preferences_payment_mode_allowed" CHECK ("performer_payout_preferences"."payment_mode" in ('test', 'live'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sway_lock_payout_recipient_during_withdrawal"() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "performer_withdrawals"
    WHERE "performer_id" = OLD."performer_id"
      AND "status" in ('requested', 'submitting', 'processing', 'unclaimed', 'held')
  ) THEN
    -- A privacy request may mark this exact environment-bound recipient for
    -- deferred purge. No payout identity field may change before terminality.
    IF TG_OP = 'UPDATE'
      AND NEW."payment_mode" IS NOT DISTINCT FROM OLD."payment_mode"
      AND NEW."destination_kind" IS NOT DISTINCT FROM OLD."destination_kind"
      AND NEW."recipient_type" IS NOT DISTINCT FROM OLD."recipient_type"
      AND NEW."recipient_value_encrypted" IS NOT DISTINCT FROM OLD."recipient_value_encrypted"
      AND NEW."recipient_value_fingerprint" IS NOT DISTINCT FROM OLD."recipient_value_fingerprint"
      AND NEW."recipient_value_preview" IS NOT DISTINCT FROM OLD."recipient_value_preview"
      AND NEW."provider" IS NOT DISTINCT FROM OLD."provider"
      AND NEW."created_at" IS NOT DISTINCT FROM OLD."created_at"
      AND NEW."privacy_deletion_requested_at" IS NOT NULL
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'payout recipient locked while withdrawal is unresolved'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
