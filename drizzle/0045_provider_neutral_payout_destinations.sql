ALTER TABLE "performer_payout_preferences" DROP CONSTRAINT "performer_payout_preferences_destination_kind_allowed";--> statement-breakpoint
UPDATE "performer_payout_preferences"
SET "destination_kind" = 'venmo'
WHERE "destination_kind" = 'venmo_direct_deposit';--> statement-breakpoint
ALTER TABLE "performer_payout_preferences" ADD CONSTRAINT "performer_payout_preferences_destination_kind_allowed" CHECK ("performer_payout_preferences"."destination_kind" in ('bank_account', 'debit_card', 'cash_app_direct_deposit', 'venmo', 'paypal'));
