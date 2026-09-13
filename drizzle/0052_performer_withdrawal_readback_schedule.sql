-- Provider GET attempts must rotate independently of payment transitions and
-- payout-submission retry clocks. NULL means this row has not been scheduled.
ALTER TABLE "performer_withdrawals"
  ADD COLUMN "provider_read_attempted_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "performer_withdrawals_pending_readback_idx"
  ON "performer_withdrawals" ("payment_mode", "provider_read_attempted_at" ASC NULLS FIRST, "id")
  WHERE "status" IN ('processing', 'unclaimed', 'held') AND "provider_payout_id" IS NOT NULL;
