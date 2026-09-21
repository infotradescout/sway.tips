CREATE TABLE "performer_withdrawals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"performer_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"destination_kind" text NOT NULL,
	"delivery_speed" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"gross_amount_cents" integer NOT NULL,
	"provider_fee_cents" integer NOT NULL,
	"net_amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"provider" text,
	"provider_payout_id" text,
	"failure_code" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_withdrawals_destination_allowed" CHECK ("performer_withdrawals"."destination_kind" in ('bank_account', 'debit_card', 'cash_app_direct_deposit', 'venmo', 'paypal')),
	CONSTRAINT "performer_withdrawals_speed_allowed" CHECK ("performer_withdrawals"."delivery_speed" in ('standard', 'instant')),
	CONSTRAINT "performer_withdrawals_status_allowed" CHECK ("performer_withdrawals"."status" in ('requested', 'processing', 'paid', 'failed', 'canceled')),
	CONSTRAINT "performer_withdrawals_positive_gross" CHECK ("performer_withdrawals"."gross_amount_cents" > 0),
	CONSTRAINT "performer_withdrawals_nonnegative_fee" CHECK ("performer_withdrawals"."provider_fee_cents" >= 0),
	CONSTRAINT "performer_withdrawals_amount_equation" CHECK ("performer_withdrawals"."net_amount_cents" > 0 and "performer_withdrawals"."net_amount_cents" + "performer_withdrawals"."provider_fee_cents" = "performer_withdrawals"."gross_amount_cents"),
	CONSTRAINT "performer_withdrawals_currency_usd" CHECK ("performer_withdrawals"."currency" = 'USD'),
	CONSTRAINT "performer_withdrawals_paid_shape" CHECK (("performer_withdrawals"."status" = 'paid' and "performer_withdrawals"."paid_at" is not null and "performer_withdrawals"."provider_payout_id" is not null) or ("performer_withdrawals"."status" <> 'paid' and "performer_withdrawals"."paid_at" is null))
);
--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_withdrawals" ADD CONSTRAINT "performer_withdrawals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "performer_withdrawals_performer_created_idx" ON "performer_withdrawals" USING btree ("performer_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_withdrawals_performer_idempotency_idx" ON "performer_withdrawals" USING btree ("performer_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_withdrawals_provider_payout_idx" ON "performer_withdrawals" USING btree ("provider","provider_payout_id") WHERE "performer_withdrawals"."provider_payout_id" is not null;