CREATE TABLE "performer_payout_kyc_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"performer_id" uuid NOT NULL,
	"process_approval_version" text NOT NULL,
	"status" text NOT NULL,
	"evidence_reference" text NOT NULL,
	"reviewer_user_id" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_payout_kyc_reviews_status_allowed" CHECK ("performer_payout_kyc_reviews"."status" in ('approved', 'revoked')),
	CONSTRAINT "performer_payout_kyc_reviews_evidence_reference_valid" CHECK (length(trim("performer_payout_kyc_reviews"."evidence_reference")) between 8 and 200),
	CONSTRAINT "performer_payout_kyc_reviews_revoked_shape" CHECK (("performer_payout_kyc_reviews"."status" = 'revoked' and "performer_payout_kyc_reviews"."revoked_at" is not null) or ("performer_payout_kyc_reviews"."status" = 'approved' and "performer_payout_kyc_reviews"."revoked_at" is null))
);
--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD COLUMN "privacy_deletion_requested_at" timestamp with time zone;--> statement-breakpoint
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
    -- Privacy deletion may mark the encrypted recipient for deferred purge,
    -- but it cannot alter or delete the destination while provider outcome is
    -- uncertain. The reconciliation worker removes the row after terminality.
    IF TG_OP = 'UPDATE'
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
$$;--> statement-breakpoint
ALTER TABLE "performer_payout_kyc_reviews" ADD CONSTRAINT "performer_payout_kyc_reviews_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_payout_kyc_reviews" ADD CONSTRAINT "performer_payout_kyc_reviews_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "performer_payout_kyc_reviews_performer_process_idx" ON "performer_payout_kyc_reviews" USING btree ("performer_id","process_approval_version");--> statement-breakpoint
CREATE INDEX "performer_payout_kyc_reviews_current_lookup_idx" ON "performer_payout_kyc_reviews" USING btree ("performer_id","status","process_approval_version");
