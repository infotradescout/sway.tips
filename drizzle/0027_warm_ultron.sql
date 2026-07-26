CREATE TYPE "public"."event_ticket_offer_status" AS ENUM('draft', 'on_sale', 'sales_closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."event_ticket_status" AS ENUM('held', 'release_pending', 'released', 'refund_pending', 'refunded', 'disputed', 'voided');--> statement-breakpoint
CREATE TYPE "public"."performer_event_ticketing_mode" AS ENUM('external', 'native_ga');--> statement-breakpoint
CREATE TYPE "public"."ticket_charge_account" AS ENUM('platform');--> statement-breakpoint
CREATE TYPE "public"."ticket_ledger_account" AS ENUM('platform_cash', 'ticket_funds_held', 'ticket_tax_payable', 'performer_payable', 'platform_fee_revenue', 'processor_fee_expense', 'buyer_refunds', 'processor_disputes');--> statement-breakpoint
CREATE TYPE "public"."ticket_ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."ticket_ledger_entry_type" AS ENUM('charge_captured', 'funds_held', 'seller_transfer_succeeded', 'buyer_refund_succeeded', 'dispute_opened', 'dispute_won', 'dispute_lost', 'charge_voided', 'processor_adjustment', 'processor_fee_recorded');--> statement-breakpoint
CREATE TYPE "public"."ticket_order_status" AS ENUM('checkout_pending', 'checkout_open', 'payment_processing', 'paid', 'payment_failed', 'expired', 'refund_pending', 'refunded', 'disputed', 'voided');--> statement-breakpoint
CREATE TYPE "public"."ticket_payment_operation_status" AS ENUM('pending', 'leased', 'retryable_failed', 'succeeded', 'terminal_failed');--> statement-breakpoint
CREATE TYPE "public"."ticket_payment_operation_type" AS ENUM('create_checkout', 'expire_checkout', 'create_seller_transfer', 'create_buyer_refund');--> statement-breakpoint
CREATE TYPE "public"."ticket_payment_processor" AS ENUM('stripe');--> statement-breakpoint
CREATE TYPE "public"."ticket_processor_event_status" AS ENUM('pending', 'processing', 'processed', 'ignored', 'retryable_failed', 'terminal_failed');--> statement-breakpoint
CREATE TYPE "public"."ticket_settlement_policy" AS ENUM('refund_only');--> statement-breakpoint
CREATE TYPE "public"."ticket_tax_mode" AS ENUM('stripe_automatic', 'not_required');--> statement-breakpoint
CREATE TABLE "event_ticket_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"status" "event_ticket_offer_status" DEFAULT 'draft' NOT NULL,
	"capacity" integer NOT NULL,
	"face_value_cents" integer NOT NULL,
	"mandatory_fee_bps" integer NOT NULL,
	"mandatory_fee_fixed_cents" integer NOT NULL,
	"mandatory_fee_cents" integer NOT NULL,
	"advertised_total_cents" integer NOT NULL,
	"seller_transfer_amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"tax_mode" "ticket_tax_mode" NOT NULL,
	"stripe_tax_code" text,
	"settlement_policy" "ticket_settlement_policy" DEFAULT 'refund_only' NOT NULL,
	"checkout_reservation_minutes" integer NOT NULL,
	"refund_grace_minutes" integer NOT NULL,
	"sales_open_at" timestamp with time zone NOT NULL,
	"sales_close_at" timestamp with time zone NOT NULL,
	"seller_stripe_account_id_snapshot" text NOT NULL,
	"seller_payment_account_status_snapshot" "payment_account_status" NOT NULL,
	"seller_kyc_status_snapshot" "kyc_status" NOT NULL,
	"seller_charges_enabled_snapshot" boolean NOT NULL,
	"seller_payouts_enabled_snapshot" boolean NOT NULL,
	"payout_readiness_checked_at" timestamp with time zone NOT NULL,
	"seller_terms_version" text NOT NULL,
	"seller_terms_hash" text NOT NULL,
	"seller_terms_text" text NOT NULL,
	"seller_terms_snapshot" jsonb NOT NULL,
	"seller_terms_accepted_by_user_id" uuid NOT NULL,
	"seller_terms_accepted_at" timestamp with time zone NOT NULL,
	"created_by_actor_user_id" uuid NOT NULL,
	"last_mutation_actor_user_id" uuid NOT NULL,
	"activated_at" timestamp with time zone,
	"sales_closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_ticket_offers_capacity_valid" CHECK ("event_ticket_offers"."capacity" > 0 and "event_ticket_offers"."capacity" <= 100000),
	CONSTRAINT "event_ticket_offers_price_valid" CHECK (
    "event_ticket_offers"."face_value_cents" >= 100
    and "event_ticket_offers"."mandatory_fee_bps" between 0 and 5000
    and "event_ticket_offers"."mandatory_fee_fixed_cents" between 0 and 10000
    and "event_ticket_offers"."mandatory_fee_cents" = (
      (("event_ticket_offers"."face_value_cents"::bigint * "event_ticket_offers"."mandatory_fee_bps") + 9999) / 10000
    ) + "event_ticket_offers"."mandatory_fee_fixed_cents"
    and "event_ticket_offers"."advertised_total_cents" = "event_ticket_offers"."face_value_cents" + "event_ticket_offers"."mandatory_fee_cents"
    and "event_ticket_offers"."advertised_total_cents" <= 1000000
    and "event_ticket_offers"."seller_transfer_amount_cents" = "event_ticket_offers"."face_value_cents"
  ),
	CONSTRAINT "event_ticket_offers_usd_only" CHECK ("event_ticket_offers"."currency" = 'USD'),
	CONSTRAINT "event_ticket_offers_tax_mode_coherent" CHECK (
    ("event_ticket_offers"."tax_mode" = 'stripe_automatic' and "event_ticket_offers"."stripe_tax_code" is not null and length(trim("event_ticket_offers"."stripe_tax_code")) > 0)
    or ("event_ticket_offers"."tax_mode" = 'not_required' and "event_ticket_offers"."stripe_tax_code" is null)
  ),
	CONSTRAINT "event_ticket_offers_sales_window_valid" CHECK ("event_ticket_offers"."sales_close_at" > "event_ticket_offers"."sales_open_at"),
	CONSTRAINT "event_ticket_offers_policy_bounds" CHECK (
    "event_ticket_offers"."checkout_reservation_minutes" between 31 and 60
    and "event_ticket_offers"."refund_grace_minutes" between 60 and 10080
  ),
	CONSTRAINT "event_ticket_offers_payout_ready" CHECK (
    "event_ticket_offers"."seller_payment_account_status_snapshot" = 'payouts_enabled'
    and "event_ticket_offers"."seller_kyc_status_snapshot" in ('not_required', 'verified')
    and "event_ticket_offers"."seller_charges_enabled_snapshot" = true
    and "event_ticket_offers"."seller_payouts_enabled_snapshot" = true
    and length(trim("event_ticket_offers"."seller_stripe_account_id_snapshot")) > 0
  ),
	CONSTRAINT "event_ticket_offers_seller_terms_valid" CHECK (
    length(trim("event_ticket_offers"."seller_terms_version")) > 0
    and "event_ticket_offers"."seller_terms_hash" ~ '^[0-9a-f]{64}$'
    and length(trim("event_ticket_offers"."seller_terms_text")) > 0
    and jsonb_typeof("event_ticket_offers"."seller_terms_snapshot") = 'object'
    and "event_ticket_offers"."seller_terms_snapshot" <> '{}'::jsonb
  ),
	CONSTRAINT "event_ticket_offers_state_timestamps" CHECK (
    ("event_ticket_offers"."status" <> 'on_sale' or "event_ticket_offers"."activated_at" is not null)
    and ("event_ticket_offers"."status" <> 'sales_closed' or "event_ticket_offers"."sales_closed_at" is not null)
    and ("event_ticket_offers"."status" <> 'cancelled' or "event_ticket_offers"."cancelled_at" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE "event_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"buyer_user_id" uuid NOT NULL,
	"status" "event_ticket_status" DEFAULT 'held' NOT NULL,
	"admission_credential_version" integer DEFAULT 1 NOT NULL,
	"admission_credential_hash" text NOT NULL,
	"admission_accepted_at" timestamp with time zone,
	"admission_accepted_by_user_id" uuid,
	"admission_idempotency_key" text,
	"admission_evidence_hash" text,
	"release_pending_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"refund_pending_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_tickets_credential_valid" CHECK (
    "event_tickets"."admission_credential_version" > 0 and "event_tickets"."admission_credential_hash" ~ '^[0-9a-f]{64}$'
  ),
	CONSTRAINT "event_tickets_admission_evidence_coherent" CHECK (
    (
      "event_tickets"."admission_accepted_at" is null
      and "event_tickets"."admission_accepted_by_user_id" is null
      and "event_tickets"."admission_idempotency_key" is null
      and "event_tickets"."admission_evidence_hash" is null
    ) or (
      "event_tickets"."admission_accepted_at" is not null
      and "event_tickets"."admission_accepted_by_user_id" is not null
      and "event_tickets"."admission_idempotency_key" is not null
      and "event_tickets"."admission_evidence_hash" ~ '^[0-9a-f]{64}$'
    )
  ),
	CONSTRAINT "event_tickets_state_evidence" CHECK (
    ("event_tickets"."status" not in ('release_pending', 'released') or "event_tickets"."admission_accepted_at" is not null)
    and ("event_tickets"."status" not in ('held', 'refund_pending', 'refunded', 'voided') or "event_tickets"."admission_accepted_at" is null)
  ),
	CONSTRAINT "event_tickets_state_timestamps" CHECK (
    ("event_tickets"."status" <> 'release_pending' or "event_tickets"."release_pending_at" is not null)
    and ("event_tickets"."status" <> 'released' or ("event_tickets"."release_pending_at" is not null and "event_tickets"."released_at" is not null))
    and ("event_tickets"."status" <> 'refund_pending' or "event_tickets"."refund_pending_at" is not null)
    and ("event_tickets"."status" <> 'refunded' or ("event_tickets"."refund_pending_at" is not null and "event_tickets"."refunded_at" is not null))
    and ("event_tickets"."status" <> 'disputed' or "event_tickets"."disputed_at" is not null)
    and ("event_tickets"."status" <> 'voided' or "event_tickets"."voided_at" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE "ticket_admission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"accepted_by_user_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"admission_credential_version" integer NOT NULL,
	"presented_credential_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_admission_events_credential_valid" CHECK (
    "ticket_admission_events"."admission_credential_version" > 0 and "ticket_admission_events"."presented_credential_hash" ~ '^[0-9a-f]{64}$'
  ),
	CONSTRAINT "ticket_admission_events_evidence_valid" CHECK (
    jsonb_typeof("ticket_admission_events"."evidence") = 'object' and "ticket_admission_events"."evidence" <> '{}'::jsonb
  ),
	CONSTRAINT "ticket_admission_events_idempotency_valid" CHECK (length(trim("ticket_admission_events"."idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "ticket_ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"ticket_id" uuid,
	"payment_operation_id" uuid,
	"entry_type" "ticket_ledger_entry_type" NOT NULL,
	"account" "ticket_ledger_account" NOT NULL,
	"direction" "ticket_ledger_direction" NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"transaction_key" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"processor_reference" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_ledger_entries_amount_valid" CHECK ("ticket_ledger_entries"."amount_cents" > 0),
	CONSTRAINT "ticket_ledger_entries_usd_only" CHECK ("ticket_ledger_entries"."currency" = 'USD'),
	CONSTRAINT "ticket_ledger_entries_keys_valid" CHECK (
    length(trim("ticket_ledger_entries"."transaction_key")) > 0 and length(trim("ticket_ledger_entries"."idempotency_key")) > 0
  )
);
--> statement-breakpoint
CREATE TABLE "ticket_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"buyer_user_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_fingerprint" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"face_value_cents" integer NOT NULL,
	"mandatory_fee_cents" integer NOT NULL,
	"advertised_total_cents" integer NOT NULL,
	"tax_total_cents" integer,
	"charged_total_cents" integer,
	"seller_transfer_amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"tax_mode_snapshot" "ticket_tax_mode" NOT NULL,
	"stripe_tax_code_snapshot" text,
	"buyer_terms_version" text NOT NULL,
	"buyer_terms_hash" text NOT NULL,
	"buyer_terms_text" text NOT NULL,
	"buyer_terms_snapshot" jsonb NOT NULL,
	"buyer_terms_accepted_at" timestamp with time zone NOT NULL,
	"status" "ticket_order_status" DEFAULT 'checkout_pending' NOT NULL,
	"processor" "ticket_payment_processor" DEFAULT 'stripe' NOT NULL,
	"charge_account" "ticket_charge_account" DEFAULT 'platform' NOT NULL,
	"capture_mode" "capture_mode" DEFAULT 'automatic' NOT NULL,
	"processor_checkout_session_id" text,
	"processor_payment_intent_id" text,
	"processor_charge_id" text,
	"processor_balance_transaction_id" text,
	"processor_fee_cents" integer,
	"processor_net_cents" integer,
	"checkout_expires_at" timestamp with time zone,
	"charged_at" timestamp with time zone,
	"payment_failed_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"refund_pending_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"disputed_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_orders_one_ticket_only" CHECK ("ticket_orders"."quantity" = 1),
	CONSTRAINT "ticket_orders_price_valid" CHECK (
    "ticket_orders"."face_value_cents" >= 100
    and "ticket_orders"."mandatory_fee_cents" >= 0
    and "ticket_orders"."advertised_total_cents" = "ticket_orders"."face_value_cents" + "ticket_orders"."mandatory_fee_cents"
    and "ticket_orders"."seller_transfer_amount_cents" = "ticket_orders"."face_value_cents"
    and "ticket_orders"."advertised_total_cents" <= 1000000
  ),
	CONSTRAINT "ticket_orders_final_charge_coherent" CHECK (
    (
      "ticket_orders"."tax_total_cents" is null
      and "ticket_orders"."charged_total_cents" is null
      and "ticket_orders"."processor_balance_transaction_id" is null
      and "ticket_orders"."processor_fee_cents" is null
      and "ticket_orders"."processor_net_cents" is null
    )
    or (
      "ticket_orders"."tax_total_cents" is not null
      and "ticket_orders"."tax_total_cents" >= 0
      and "ticket_orders"."charged_total_cents" = "ticket_orders"."advertised_total_cents" + "ticket_orders"."tax_total_cents"
      and "ticket_orders"."processor_balance_transaction_id" is not null
      and length(trim("ticket_orders"."processor_balance_transaction_id")) > 0
      and "ticket_orders"."processor_fee_cents" is not null
      and "ticket_orders"."processor_fee_cents" >= 0
      and "ticket_orders"."processor_net_cents" is not null
      and "ticket_orders"."processor_net_cents" = "ticket_orders"."charged_total_cents" - "ticket_orders"."processor_fee_cents"
      and "ticket_orders"."processor_net_cents" > 0
    )
  ),
	CONSTRAINT "ticket_orders_usd_only" CHECK ("ticket_orders"."currency" = 'USD'),
	CONSTRAINT "ticket_orders_automatic_platform_charge" CHECK ("ticket_orders"."capture_mode" = 'automatic'),
	CONSTRAINT "ticket_orders_request_fingerprint_valid" CHECK ("ticket_orders"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ticket_orders_buyer_terms_valid" CHECK (
    length(trim("ticket_orders"."buyer_terms_version")) > 0
    and "ticket_orders"."buyer_terms_hash" ~ '^[0-9a-f]{64}$'
    and length(trim("ticket_orders"."buyer_terms_text")) > 0
    and jsonb_typeof("ticket_orders"."buyer_terms_snapshot") = 'object'
    and "ticket_orders"."buyer_terms_snapshot" <> '{}'::jsonb
  ),
	CONSTRAINT "ticket_orders_charged_state_coherent" CHECK (
    "ticket_orders"."status" not in ('paid', 'refund_pending', 'refunded', 'disputed')
    or (
      "ticket_orders"."charged_at" is not null
      and "ticket_orders"."processor_payment_intent_id" is not null
      and "ticket_orders"."processor_charge_id" is not null
      and "ticket_orders"."tax_total_cents" is not null
      and "ticket_orders"."charged_total_cents" is not null
      and "ticket_orders"."processor_balance_transaction_id" is not null
      and "ticket_orders"."processor_fee_cents" is not null
      and "ticket_orders"."processor_net_cents" is not null
    )
  ),
	CONSTRAINT "ticket_orders_state_timestamps" CHECK (
    ("ticket_orders"."status" <> 'checkout_open' or ("ticket_orders"."processor_checkout_session_id" is not null and "ticket_orders"."checkout_expires_at" is not null))
    and ("ticket_orders"."status" <> 'payment_failed' or "ticket_orders"."payment_failed_at" is not null)
    and ("ticket_orders"."status" <> 'expired' or "ticket_orders"."expired_at" is not null)
    and ("ticket_orders"."status" <> 'refund_pending' or "ticket_orders"."refund_pending_at" is not null)
    and ("ticket_orders"."status" <> 'refunded' or ("ticket_orders"."refund_pending_at" is not null and "ticket_orders"."refunded_at" is not null))
    and ("ticket_orders"."status" <> 'disputed' or "ticket_orders"."disputed_at" is not null)
    and ("ticket_orders"."status" <> 'voided' or "ticket_orders"."voided_at" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE "ticket_payment_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"ticket_id" uuid,
	"operation_type" "ticket_payment_operation_type" NOT NULL,
	"status" "ticket_payment_operation_status" DEFAULT 'pending' NOT NULL,
	"processor" "ticket_payment_processor" DEFAULT 'stripe' NOT NULL,
	"idempotency_key" text NOT NULL,
	"amount_cents" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"request_payload" jsonb NOT NULL,
	"processor_object_id" text,
	"result_payload" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 12 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_payment_operations_usd_only" CHECK ("ticket_payment_operations"."currency" = 'USD'),
	CONSTRAINT "ticket_payment_operations_request_payload_valid" CHECK (jsonb_typeof("ticket_payment_operations"."request_payload") = 'object'),
	CONSTRAINT "ticket_payment_operations_attempts_valid" CHECK (
    "ticket_payment_operations"."attempt_count" >= 0 and "ticket_payment_operations"."max_attempts" > 0
  ),
	CONSTRAINT "ticket_payment_operations_lease_coherent" CHECK (
    ("ticket_payment_operations"."status" = 'leased' and "ticket_payment_operations"."lease_owner" is not null and "ticket_payment_operations"."lease_expires_at" is not null)
    or ("ticket_payment_operations"."status" <> 'leased' and "ticket_payment_operations"."lease_owner" is null and "ticket_payment_operations"."lease_expires_at" is null)
  ),
	CONSTRAINT "ticket_payment_operations_ticket_required" CHECK (
    ("ticket_payment_operations"."operation_type" in ('create_checkout', 'expire_checkout') and "ticket_payment_operations"."ticket_id" is null)
    or ("ticket_payment_operations"."operation_type" in ('create_seller_transfer', 'create_buyer_refund') and "ticket_payment_operations"."ticket_id" is not null)
  ),
	CONSTRAINT "ticket_payment_operations_amount_valid" CHECK (
    ("ticket_payment_operations"."operation_type" = 'expire_checkout' and "ticket_payment_operations"."amount_cents" is null)
    or ("ticket_payment_operations"."operation_type" <> 'expire_checkout' and "ticket_payment_operations"."amount_cents" is not null and "ticket_payment_operations"."amount_cents" > 0)
  ),
	CONSTRAINT "ticket_payment_operations_completion_coherent" CHECK (
    ("ticket_payment_operations"."status" not in ('succeeded', 'terminal_failed') and "ticket_payment_operations"."completed_at" is null)
    or ("ticket_payment_operations"."status" in ('succeeded', 'terminal_failed') and "ticket_payment_operations"."completed_at" is not null)
  )
);
--> statement-breakpoint
CREATE TABLE "ticket_processor_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"processor" "ticket_payment_processor" DEFAULT 'stripe' NOT NULL,
	"processor_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"livemode" boolean NOT NULL,
	"order_id" uuid,
	"ticket_id" uuid,
	"payment_operation_id" uuid,
	"status" "ticket_processor_event_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_processor_events_payload_hash_valid" CHECK ("ticket_processor_events"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ticket_processor_events_payload_valid" CHECK (jsonb_typeof("ticket_processor_events"."payload") = 'object'),
	CONSTRAINT "ticket_processor_events_attempts_valid" CHECK ("ticket_processor_events"."attempt_count" >= 0),
	CONSTRAINT "ticket_processor_events_processed_state" CHECK (
    ("ticket_processor_events"."status" in ('processed', 'ignored') and "ticket_processor_events"."processed_at" is not null)
    or ("ticket_processor_events"."status" not in ('processed', 'ignored') and "ticket_processor_events"."processed_at" is null)
  )
);
--> statement-breakpoint
ALTER TABLE "performer_events" DROP CONSTRAINT "performer_events_published_has_external_ticket";--> statement-breakpoint
ALTER TABLE "performer_events" ADD COLUMN "ticketing_mode" "performer_event_ticketing_mode" DEFAULT 'external' NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_events" ADD COLUMN "door_opens_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "performer_events_id_performer_idx" ON "performer_events" USING btree ("id","performer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_ticket_offers_identity_idx" ON "event_ticket_offers" USING btree ("id","event_id","performer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_orders_identity_idx" ON "ticket_orders" USING btree ("id","offer_id","event_id","performer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_tickets_identity_idx" ON "event_tickets" USING btree ("id","order_id","offer_id","event_id","performer_id");--> statement-breakpoint
ALTER TABLE "event_ticket_offers" ADD CONSTRAINT "event_ticket_offers_seller_terms_accepted_by_user_id_users_id_fk" FOREIGN KEY ("seller_terms_accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ticket_offers" ADD CONSTRAINT "event_ticket_offers_created_by_actor_user_id_users_id_fk" FOREIGN KEY ("created_by_actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ticket_offers" ADD CONSTRAINT "event_ticket_offers_last_mutation_actor_user_id_users_id_fk" FOREIGN KEY ("last_mutation_actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_ticket_offers" ADD CONSTRAINT "event_ticket_offers_event_performer_fk" FOREIGN KEY ("event_id","performer_id") REFERENCES "public"."performer_events"("id","performer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_admission_accepted_by_user_id_users_id_fk" FOREIGN KEY ("admission_accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_tickets" ADD CONSTRAINT "event_tickets_order_fk" FOREIGN KEY ("order_id","offer_id","event_id","performer_id") REFERENCES "public"."ticket_orders"("id","offer_id","event_id","performer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_admission_events" ADD CONSTRAINT "ticket_admission_events_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_admission_events" ADD CONSTRAINT "ticket_admission_events_ticket_fk" FOREIGN KEY ("ticket_id","order_id","offer_id","event_id","performer_id") REFERENCES "public"."event_tickets"("id","order_id","offer_id","event_id","performer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_ledger_entries" ADD CONSTRAINT "ticket_ledger_entries_order_id_ticket_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ticket_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_ledger_entries" ADD CONSTRAINT "ticket_ledger_entries_ticket_id_event_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."event_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_ledger_entries" ADD CONSTRAINT "ticket_ledger_entries_payment_operation_id_ticket_payment_operations_id_fk" FOREIGN KEY ("payment_operation_id") REFERENCES "public"."ticket_payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_buyer_user_id_users_id_fk" FOREIGN KEY ("buyer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_orders" ADD CONSTRAINT "ticket_orders_offer_fk" FOREIGN KEY ("offer_id","event_id","performer_id") REFERENCES "public"."event_ticket_offers"("id","event_id","performer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_payment_operations" ADD CONSTRAINT "ticket_payment_operations_order_id_ticket_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ticket_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_payment_operations" ADD CONSTRAINT "ticket_payment_operations_ticket_id_event_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."event_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_processor_events" ADD CONSTRAINT "ticket_processor_events_order_id_ticket_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."ticket_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_processor_events" ADD CONSTRAINT "ticket_processor_events_ticket_id_event_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."event_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_processor_events" ADD CONSTRAINT "ticket_processor_events_payment_operation_id_ticket_payment_operations_id_fk" FOREIGN KEY ("payment_operation_id") REFERENCES "public"."ticket_payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_ticket_offers_event_idx" ON "event_ticket_offers" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_ticket_offers_performer_status_idx" ON "event_ticket_offers" USING btree ("performer_id","status");--> statement-breakpoint
CREATE INDEX "event_ticket_offers_sales_window_idx" ON "event_ticket_offers" USING btree ("status","sales_open_at","sales_close_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_tickets_order_idx" ON "event_tickets" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_tickets_admission_key_idx" ON "event_tickets" USING btree ("admission_idempotency_key") WHERE "event_tickets"."admission_idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "event_tickets_event_status_idx" ON "event_tickets" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "event_tickets_buyer_created_idx" ON "event_tickets" USING btree ("buyer_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_admission_events_ticket_idx" ON "ticket_admission_events" USING btree ("ticket_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_admission_events_idempotency_idx" ON "ticket_admission_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_admission_events_actor_request_idx" ON "ticket_admission_events" USING btree ("accepted_by_user_id","client_request_id");--> statement-breakpoint
CREATE INDEX "ticket_admission_events_event_accepted_idx" ON "ticket_admission_events" USING btree ("event_id","accepted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_ledger_entries_idempotency_idx" ON "ticket_ledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ticket_ledger_entries_transaction_idx" ON "ticket_ledger_entries" USING btree ("transaction_key");--> statement-breakpoint
CREATE INDEX "ticket_ledger_entries_order_occurred_idx" ON "ticket_ledger_entries" USING btree ("order_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ticket_ledger_entries_ticket_occurred_idx" ON "ticket_ledger_entries" USING btree ("ticket_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_orders_buyer_request_idx" ON "ticket_orders" USING btree ("buyer_user_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_orders_offer_buyer_active_idx" ON "ticket_orders" USING btree ("offer_id","buyer_user_id") WHERE "ticket_orders"."status" in ('checkout_pending', 'checkout_open', 'payment_processing', 'paid', 'disputed') and not ("ticket_orders"."status" = 'disputed' and "ticket_orders"."refunded_at" is not null);--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_orders_checkout_session_idx" ON "ticket_orders" USING btree ("processor_checkout_session_id") WHERE "ticket_orders"."processor_checkout_session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_orders_payment_intent_idx" ON "ticket_orders" USING btree ("processor_payment_intent_id") WHERE "ticket_orders"."processor_payment_intent_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_orders_charge_idx" ON "ticket_orders" USING btree ("processor_charge_id") WHERE "ticket_orders"."processor_charge_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_orders_balance_transaction_idx" ON "ticket_orders" USING btree ("processor_balance_transaction_id") WHERE "ticket_orders"."processor_balance_transaction_id" is not null;--> statement-breakpoint
CREATE INDEX "ticket_orders_offer_status_idx" ON "ticket_orders" USING btree ("offer_id","status");--> statement-breakpoint
CREATE INDEX "ticket_orders_buyer_created_idx" ON "ticket_orders" USING btree ("buyer_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_payment_operations_idempotency_idx" ON "ticket_payment_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_payment_operations_order_type_idx" ON "ticket_payment_operations" USING btree ("order_id","operation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_payment_operations_processor_object_idx" ON "ticket_payment_operations" USING btree ("processor_object_id") WHERE "ticket_payment_operations"."processor_object_id" is not null;--> statement-breakpoint
CREATE INDEX "ticket_payment_operations_claim_idx" ON "ticket_payment_operations" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "ticket_payment_operations_ticket_type_idx" ON "ticket_payment_operations" USING btree ("ticket_id","operation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_processor_events_event_idx" ON "ticket_processor_events" USING btree ("processor","processor_event_id");--> statement-breakpoint
CREATE INDEX "ticket_processor_events_reconcile_idx" ON "ticket_processor_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "ticket_processor_events_order_received_idx" ON "ticket_processor_events" USING btree ("order_id","received_at");--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_ticketing_mode_exclusive" CHECK ("performer_events"."ticketing_mode" = 'external' OR ("performer_events"."external_ticket_url" IS NULL AND "performer_events"."external_ticket_label" IS NULL));--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_native_door_required" CHECK ("performer_events"."ticketing_mode" <> 'native_ga' OR "performer_events"."door_opens_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_door_not_after_start" CHECK ("performer_events"."door_opens_at" IS NULL OR "performer_events"."door_opens_at" <= "performer_events"."starts_at");--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_published_has_external_ticket" CHECK ("performer_events"."status" <> 'published' OR "performer_events"."ticketing_mode" = 'native_ga' OR "performer_events"."external_ticket_url" IS NOT NULL);
--> statement-breakpoint
CREATE FUNCTION "sway_reject_ticket_evidence_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_guard_performer_event_ticketing_mode"() RETURNS trigger AS $$
BEGIN
  IF NEW."ticketing_mode" IS DISTINCT FROM OLD."ticketing_mode" THEN
    RAISE EXCEPTION 'performer event ticketing mode is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_guard_published_native_event_fulfillment"() RETURNS trigger AS $$
BEGIN
  IF OLD."ticketing_mode" = 'native_ga' AND OLD."status" = 'published' THEN
    IF NEW."performer_id" IS DISTINCT FROM OLD."performer_id"
      OR NEW."title" IS DISTINCT FROM OLD."title"
      OR NEW."description" IS DISTINCT FROM OLD."description"
      OR NEW."starts_at" IS DISTINCT FROM OLD."starts_at"
      OR NEW."door_opens_at" IS DISTINCT FROM OLD."door_opens_at"
      OR NEW."ends_at" IS DISTINCT FROM OLD."ends_at"
      OR NEW."time_zone" IS DISTINCT FROM OLD."time_zone"
      OR NEW."location_name" IS DISTINCT FROM OLD."location_name"
      OR NEW."location_address" IS DISTINCT FROM OLD."location_address"
      OR NEW."city" IS DISTINCT FROM OLD."city"
      OR NEW."location_is_tba" IS DISTINCT FROM OLD."location_is_tba"
      OR NEW."cover_image_url" IS DISTINCT FROM OLD."cover_image_url"
      OR NEW."visibility" IS DISTINCT FROM OLD."visibility"
      OR NEW."published_at" IS DISTINCT FROM OLD."published_at" THEN
      RAISE EXCEPTION 'published native event fulfillment terms are sealed';
    END IF;
    IF NEW."status" NOT IN ('published', 'cancelled') THEN
      RAISE EXCEPTION 'published native event may only remain published or be cancelled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_guard_event_ticket_offer"() RETURNS trigger AS $$
DECLARE
  reserved_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'event ticket offers cannot be deleted';
  END IF;

  IF NEW."event_id" IS DISTINCT FROM OLD."event_id"
    OR NEW."performer_id" IS DISTINCT FROM OLD."performer_id"
    OR NEW."created_by_actor_user_id" IS DISTINCT FROM OLD."created_by_actor_user_id" THEN
    RAISE EXCEPTION 'event ticket offer identity is immutable';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'draft' AND NEW."status" IN ('on_sale', 'cancelled'))
    OR (OLD."status" = 'on_sale' AND NEW."status" IN ('sales_closed', 'cancelled'))
    OR (OLD."status" = 'sales_closed' AND NEW."status" = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'illegal event ticket offer status transition: % -> %', OLD."status", NEW."status";
  END IF;

  SELECT COALESCE(sum("quantity"), 0)::integer
    INTO reserved_count
    FROM "ticket_orders"
   WHERE "offer_id" = OLD."id"
     AND "status" IN ('checkout_pending', 'checkout_open', 'payment_processing', 'paid');

  IF NEW."capacity" < reserved_count THEN
    RAISE EXCEPTION 'event ticket capacity cannot be lower than active reservations';
  END IF;

  IF OLD."status" <> 'draft' OR reserved_count > 0 THEN
    IF NEW."capacity" IS DISTINCT FROM OLD."capacity"
      OR NEW."face_value_cents" IS DISTINCT FROM OLD."face_value_cents"
      OR NEW."mandatory_fee_bps" IS DISTINCT FROM OLD."mandatory_fee_bps"
      OR NEW."mandatory_fee_fixed_cents" IS DISTINCT FROM OLD."mandatory_fee_fixed_cents"
      OR NEW."mandatory_fee_cents" IS DISTINCT FROM OLD."mandatory_fee_cents"
      OR NEW."advertised_total_cents" IS DISTINCT FROM OLD."advertised_total_cents"
      OR NEW."seller_transfer_amount_cents" IS DISTINCT FROM OLD."seller_transfer_amount_cents"
      OR NEW."currency" IS DISTINCT FROM OLD."currency"
      OR NEW."tax_mode" IS DISTINCT FROM OLD."tax_mode"
      OR NEW."stripe_tax_code" IS DISTINCT FROM OLD."stripe_tax_code"
      OR NEW."settlement_policy" IS DISTINCT FROM OLD."settlement_policy"
      OR NEW."checkout_reservation_minutes" IS DISTINCT FROM OLD."checkout_reservation_minutes"
      OR NEW."refund_grace_minutes" IS DISTINCT FROM OLD."refund_grace_minutes"
      OR NEW."sales_open_at" IS DISTINCT FROM OLD."sales_open_at"
      OR NEW."sales_close_at" IS DISTINCT FROM OLD."sales_close_at"
      OR NEW."seller_stripe_account_id_snapshot" IS DISTINCT FROM OLD."seller_stripe_account_id_snapshot"
      OR NEW."seller_payment_account_status_snapshot" IS DISTINCT FROM OLD."seller_payment_account_status_snapshot"
      OR NEW."seller_kyc_status_snapshot" IS DISTINCT FROM OLD."seller_kyc_status_snapshot"
      OR NEW."seller_charges_enabled_snapshot" IS DISTINCT FROM OLD."seller_charges_enabled_snapshot"
      OR NEW."seller_payouts_enabled_snapshot" IS DISTINCT FROM OLD."seller_payouts_enabled_snapshot"
      OR NEW."payout_readiness_checked_at" IS DISTINCT FROM OLD."payout_readiness_checked_at"
      OR NEW."seller_terms_version" IS DISTINCT FROM OLD."seller_terms_version"
      OR NEW."seller_terms_hash" IS DISTINCT FROM OLD."seller_terms_hash"
      OR NEW."seller_terms_text" IS DISTINCT FROM OLD."seller_terms_text"
      OR NEW."seller_terms_snapshot" IS DISTINCT FROM OLD."seller_terms_snapshot"
      OR NEW."seller_terms_accepted_by_user_id" IS DISTINCT FROM OLD."seller_terms_accepted_by_user_id"
      OR NEW."seller_terms_accepted_at" IS DISTINCT FROM OLD."seller_terms_accepted_at" THEN
      RAISE EXCEPTION 'event ticket offer commercial terms are sealed';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_reserve_event_ticket_capacity"() RETURNS trigger AS $$
DECLARE
  offer_row "event_ticket_offers"%ROWTYPE;
  reserved_count integer;
BEGIN
  IF TG_OP = 'INSERT' AND NEW."status" <> 'checkout_pending' THEN
    RAISE EXCEPTION 'new ticket orders must begin checkout_pending';
  END IF;

  IF NEW."status" NOT IN ('checkout_pending', 'checkout_open', 'payment_processing', 'paid', 'refund_pending', 'disputed') THEN
    RETURN NEW;
  END IF;
  IF NEW."status" = 'disputed' AND NEW."refunded_at" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Capacity is reserved exactly once, when the order is inserted. Every legal
  -- later transition is constrained by sway_guard_ticket_order; re-running the
  -- sale-window check here would reject a late processor success that must move
  -- an expired order into the full-refund path.
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO offer_row
    FROM "event_ticket_offers"
   WHERE "id" = NEW."offer_id"
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ticket offer not found';
  END IF;
  IF offer_row."status" <> 'on_sale'
    OR now() < offer_row."sales_open_at"
    OR now() >= offer_row."sales_close_at" THEN
    RAISE EXCEPTION 'ticket offer is not on sale';
  END IF;

  SELECT COALESCE(sum("quantity"), 0)::integer
    INTO reserved_count
    FROM "ticket_orders"
   WHERE "offer_id" = NEW."offer_id"
     AND "status" IN ('checkout_pending', 'checkout_open', 'payment_processing', 'paid', 'refund_pending', 'disputed')
     AND NOT ("status" = 'disputed' AND "refunded_at" IS NOT NULL)
     AND NOT (
       "status" = 'refund_pending'
       AND (
         "expired_at" IS NOT NULL
         OR "payment_failed_at" IS NOT NULL
         OR "voided_at" IS NOT NULL
       )
     )
     AND (TG_OP = 'INSERT' OR "id" <> NEW."id");
  IF reserved_count + NEW."quantity" > offer_row."capacity" THEN
    RAISE EXCEPTION 'ticket offer capacity exhausted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_guard_ticket_order"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ticket orders cannot be deleted';
  END IF;

  IF NEW."offer_id" IS DISTINCT FROM OLD."offer_id"
    OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
    OR NEW."performer_id" IS DISTINCT FROM OLD."performer_id"
    OR NEW."buyer_user_id" IS DISTINCT FROM OLD."buyer_user_id"
    OR NEW."client_request_id" IS DISTINCT FROM OLD."client_request_id"
    OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
    OR NEW."quantity" IS DISTINCT FROM OLD."quantity"
    OR NEW."face_value_cents" IS DISTINCT FROM OLD."face_value_cents"
    OR NEW."mandatory_fee_cents" IS DISTINCT FROM OLD."mandatory_fee_cents"
    OR NEW."advertised_total_cents" IS DISTINCT FROM OLD."advertised_total_cents"
    OR NEW."seller_transfer_amount_cents" IS DISTINCT FROM OLD."seller_transfer_amount_cents"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."tax_mode_snapshot" IS DISTINCT FROM OLD."tax_mode_snapshot"
    OR NEW."stripe_tax_code_snapshot" IS DISTINCT FROM OLD."stripe_tax_code_snapshot"
    OR NEW."buyer_terms_version" IS DISTINCT FROM OLD."buyer_terms_version"
    OR NEW."buyer_terms_hash" IS DISTINCT FROM OLD."buyer_terms_hash"
    OR NEW."buyer_terms_text" IS DISTINCT FROM OLD."buyer_terms_text"
    OR NEW."buyer_terms_snapshot" IS DISTINCT FROM OLD."buyer_terms_snapshot"
    OR NEW."buyer_terms_accepted_at" IS DISTINCT FROM OLD."buyer_terms_accepted_at"
    OR NEW."processor" IS DISTINCT FROM OLD."processor"
    OR NEW."charge_account" IS DISTINCT FROM OLD."charge_account"
    OR NEW."capture_mode" IS DISTINCT FROM OLD."capture_mode" THEN
    RAISE EXCEPTION 'ticket order identity, price, and terms are immutable';
  END IF;

  IF (OLD."processor_checkout_session_id" IS NOT NULL AND NEW."processor_checkout_session_id" IS DISTINCT FROM OLD."processor_checkout_session_id")
    OR (OLD."processor_payment_intent_id" IS NOT NULL AND NEW."processor_payment_intent_id" IS DISTINCT FROM OLD."processor_payment_intent_id")
    OR (OLD."processor_charge_id" IS NOT NULL AND NEW."processor_charge_id" IS DISTINCT FROM OLD."processor_charge_id")
    OR (OLD."processor_balance_transaction_id" IS NOT NULL AND NEW."processor_balance_transaction_id" IS DISTINCT FROM OLD."processor_balance_transaction_id")
    OR (OLD."processor_fee_cents" IS NOT NULL AND NEW."processor_fee_cents" IS DISTINCT FROM OLD."processor_fee_cents")
    OR (OLD."processor_net_cents" IS NOT NULL AND NEW."processor_net_cents" IS DISTINCT FROM OLD."processor_net_cents")
    OR (OLD."tax_total_cents" IS NOT NULL AND NEW."tax_total_cents" IS DISTINCT FROM OLD."tax_total_cents")
    OR (OLD."charged_total_cents" IS NOT NULL AND NEW."charged_total_cents" IS DISTINCT FROM OLD."charged_total_cents") THEN
    RAISE EXCEPTION 'ticket order processor evidence is immutable once recorded';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'checkout_pending' AND NEW."status" IN ('checkout_open', 'payment_processing', 'paid', 'payment_failed', 'expired', 'voided', 'refund_pending'))
    OR (OLD."status" = 'checkout_open' AND NEW."status" IN ('payment_processing', 'paid', 'payment_failed', 'expired', 'voided', 'refund_pending'))
    OR (OLD."status" = 'payment_processing' AND NEW."status" IN ('paid', 'payment_failed', 'expired', 'refund_pending'))
    OR (OLD."status" = 'paid' AND NEW."status" IN ('refund_pending', 'disputed'))
    OR (OLD."status" IN ('expired', 'payment_failed', 'voided') AND NEW."status" = 'refund_pending')
    OR (OLD."status" = 'refund_pending' AND NEW."status" IN ('refunded', 'disputed'))
    OR (OLD."status" = 'disputed' AND NEW."status" IN ('paid', 'refund_pending', 'refunded'))
    OR (OLD."status" = 'refunded' AND NEW."status" = 'disputed')
  ) THEN
    RAISE EXCEPTION 'illegal ticket order status transition: % -> %', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_guard_event_ticket"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'event tickets cannot be deleted';
  END IF;
  IF NEW."order_id" IS DISTINCT FROM OLD."order_id"
    OR NEW."offer_id" IS DISTINCT FROM OLD."offer_id"
    OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
    OR NEW."performer_id" IS DISTINCT FROM OLD."performer_id"
    OR NEW."buyer_user_id" IS DISTINCT FROM OLD."buyer_user_id"
    OR NEW."admission_credential_version" IS DISTINCT FROM OLD."admission_credential_version"
    OR NEW."admission_credential_hash" IS DISTINCT FROM OLD."admission_credential_hash" THEN
    RAISE EXCEPTION 'event ticket identity and admission credential are immutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'held' AND NEW."status" IN ('release_pending', 'refund_pending', 'disputed', 'voided'))
    OR (OLD."status" = 'release_pending' AND NEW."status" IN ('released', 'disputed'))
    OR (OLD."status" = 'released' AND NEW."status" = 'disputed')
    OR (OLD."status" = 'refund_pending' AND NEW."status" IN ('refunded', 'disputed'))
    OR (OLD."status" = 'refunded' AND NEW."status" = 'disputed')
    OR (OLD."status" = 'disputed' AND NEW."status" IN ('held', 'release_pending', 'released', 'refund_pending', 'refunded'))
  ) THEN
    RAISE EXCEPTION 'illegal event ticket status transition: % -> %', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_guard_ticket_processor_event"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ticket processor events cannot be deleted';
  END IF;
  IF NEW."processor" IS DISTINCT FROM OLD."processor"
    OR NEW."processor_event_id" IS DISTINCT FROM OLD."processor_event_id"
    OR NEW."event_type" IS DISTINCT FROM OLD."event_type"
    OR NEW."payload_sha256" IS DISTINCT FROM OLD."payload_sha256"
    OR NEW."payload" IS DISTINCT FROM OLD."payload"
    OR NEW."livemode" IS DISTINCT FROM OLD."livemode" THEN
    RAISE EXCEPTION 'ticket processor event evidence is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_guard_ticket_payment_operation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ticket payment operations cannot be deleted';
  END IF;
  IF NEW."order_id" IS DISTINCT FROM OLD."order_id"
    OR NEW."ticket_id" IS DISTINCT FROM OLD."ticket_id"
    OR NEW."operation_type" IS DISTINCT FROM OLD."operation_type"
    OR NEW."processor" IS DISTINCT FROM OLD."processor"
    OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
    OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."request_payload" IS DISTINCT FROM OLD."request_payload"
    OR NEW."max_attempts" IS DISTINCT FROM OLD."max_attempts"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'ticket payment operation identity and commercial request are immutable';
  END IF;
  IF OLD."processor_object_id" IS NOT NULL
    AND NEW."processor_object_id" IS DISTINCT FROM OLD."processor_object_id" THEN
    RAISE EXCEPTION 'ticket payment operation processor evidence is immutable once recorded';
  END IF;
  IF NEW."attempt_count" < OLD."attempt_count" THEN
    RAISE EXCEPTION 'ticket payment operation attempt count cannot decrease';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "performer_events_ticketing_mode_immutable"
  BEFORE UPDATE OF "ticketing_mode" ON "performer_events"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_performer_event_ticketing_mode"();
--> statement-breakpoint
CREATE TRIGGER "performer_events_published_native_fulfillment_guard"
  BEFORE UPDATE ON "performer_events"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_published_native_event_fulfillment"();
--> statement-breakpoint
CREATE TRIGGER "event_ticket_offers_guard"
  BEFORE UPDATE OR DELETE ON "event_ticket_offers"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_event_ticket_offer"();
--> statement-breakpoint
CREATE TRIGGER "ticket_orders_capacity_reservation"
  BEFORE INSERT OR UPDATE OF "status" ON "ticket_orders"
  FOR EACH ROW EXECUTE FUNCTION "sway_reserve_event_ticket_capacity"();
--> statement-breakpoint
CREATE TRIGGER "ticket_orders_guard"
  BEFORE UPDATE OR DELETE ON "ticket_orders"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_ticket_order"();
--> statement-breakpoint
CREATE TRIGGER "event_tickets_guard"
  BEFORE UPDATE OR DELETE ON "event_tickets"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_event_ticket"();
--> statement-breakpoint
CREATE TRIGGER "ticket_payment_operations_guard"
  BEFORE UPDATE OR DELETE ON "ticket_payment_operations"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_ticket_payment_operation"();
--> statement-breakpoint
CREATE TRIGGER "ticket_processor_events_guard"
  BEFORE UPDATE OR DELETE ON "ticket_processor_events"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_ticket_processor_event"();
--> statement-breakpoint
CREATE TRIGGER "ticket_ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "ticket_ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "sway_reject_ticket_evidence_mutation"();
--> statement-breakpoint
CREATE TRIGGER "ticket_admission_events_append_only"
  BEFORE UPDATE OR DELETE ON "ticket_admission_events"
  FOR EACH ROW EXECUTE FUNCTION "sway_reject_ticket_evidence_mutation"();
