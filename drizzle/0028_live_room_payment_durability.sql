CREATE TYPE "public"."live_room_payment_operation_status" AS ENUM('pending', 'leased', 'awaiting_customer', 'retryable_failed', 'succeeded', 'terminal_failed');--> statement-breakpoint
CREATE TYPE "public"."live_room_payment_operation_type" AS ENUM('authorize', 'capture', 'reverse');--> statement-breakpoint
CREATE TYPE "public"."live_room_processor_event_status" AS ENUM('pending', 'processing', 'processed', 'ignored', 'retryable_failed', 'terminal_failed');--> statement-breakpoint
CREATE TABLE "live_room_payment_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"gig_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"request_id" uuid,
	"request_boost_id" uuid,
	"operation_type" "live_room_payment_operation_type" NOT NULL,
	"status" "live_room_payment_operation_status" DEFAULT 'pending' NOT NULL,
	"processor" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"destination_account_id" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"processor_object_id" text,
	"result_payload" jsonb,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 20 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_room_payment_operations_request_payload_valid" CHECK (jsonb_typeof("live_room_payment_operations"."request_payload") = 'object'),
	CONSTRAINT "live_room_payment_operations_action_link" CHECK (
    (("live_room_payment_operations"."request_id" is not null)::int + ("live_room_payment_operations"."request_boost_id" is not null)::int) = 1
    or (
      "live_room_payment_operations"."operation_type" = 'reverse'
      and "live_room_payment_operations"."request_id" is null
      and "live_room_payment_operations"."request_boost_id" is null
    )
  ),
	CONSTRAINT "live_room_payment_operations_attempts_valid" CHECK ("live_room_payment_operations"."attempt_count" >= 0 and "live_room_payment_operations"."max_attempts" > 0),
	CONSTRAINT "live_room_payment_operations_lease_coherent" CHECK (
    ("live_room_payment_operations"."status" = 'leased' and "live_room_payment_operations"."lease_owner" is not null and "live_room_payment_operations"."lease_expires_at" is not null)
    or ("live_room_payment_operations"."status" <> 'leased' and "live_room_payment_operations"."lease_owner" is null and "live_room_payment_operations"."lease_expires_at" is null)
  ),
	CONSTRAINT "live_room_payment_operations_completion_coherent" CHECK (
    ("live_room_payment_operations"."status" in ('succeeded', 'terminal_failed') and "live_room_payment_operations"."completed_at" is not null)
    or ("live_room_payment_operations"."status" not in ('succeeded', 'terminal_failed') and "live_room_payment_operations"."completed_at" is null)
  )
);
--> statement-breakpoint
CREATE TABLE "live_room_processor_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"processor" text NOT NULL,
	"processor_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"payload" jsonb NOT NULL,
	"livemode" boolean NOT NULL,
	"payment_id" uuid,
	"payment_operation_id" uuid,
	"status" "live_room_processor_event_status" DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_room_processor_events_payload_hash_valid" CHECK ("live_room_processor_events"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "live_room_processor_events_payload_valid" CHECK (jsonb_typeof("live_room_processor_events"."payload") = 'object'),
	CONSTRAINT "live_room_processor_events_attempts_valid" CHECK ("live_room_processor_events"."attempt_count" >= 0),
	CONSTRAINT "live_room_processor_events_processed_state" CHECK (
    ("live_room_processor_events"."status" in ('processed', 'ignored') and "live_room_processor_events"."processed_at" is not null)
    or ("live_room_processor_events"."status" not in ('processed', 'ignored') and "live_room_processor_events"."processed_at" is null)
  )
);
--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD COLUMN "state_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "performer_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "action_type" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "destination_account_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "legacy_unlinked" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD COLUMN "client_request_id" text;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD COLUMN "intent_fingerprint" text;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD COLUMN "patron_device_id_hash" text;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD COLUMN "activated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "request_boosts" ADD COLUMN "state_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "intent_fingerprint" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "patron_device_id_hash" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "activated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "state_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "request_boosts"
SET "client_request_id" = 'legacy-' || "id"::text
WHERE "client_request_id" IS NULL;--> statement-breakpoint
UPDATE "requests" SET "activated_at" = "created_at" WHERE "activated_at" IS NULL;--> statement-breakpoint
UPDATE "request_boosts" SET "activated_at" = "created_at" WHERE "activated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD CONSTRAINT "live_room_payment_operations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD CONSTRAINT "live_room_payment_operations_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD CONSTRAINT "live_room_payment_operations_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD CONSTRAINT "live_room_payment_operations_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD CONSTRAINT "live_room_payment_operations_request_boost_id_request_boosts_id_fk" FOREIGN KEY ("request_boost_id") REFERENCES "public"."request_boosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_room_processor_events" ADD CONSTRAINT "live_room_processor_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_room_processor_events" ADD CONSTRAINT "live_room_processor_events_payment_operation_id_live_room_payment_operations_id_fk" FOREIGN KEY ("payment_operation_id") REFERENCES "public"."live_room_payment_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_room_payment_operations_idempotency_idx" ON "live_room_payment_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "live_room_payment_operations_payment_type_idx" ON "live_room_payment_operations" USING btree ("payment_id","operation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "live_room_payment_operations_processor_object_idx" ON "live_room_payment_operations" USING btree ("operation_type","processor_object_id") WHERE "live_room_payment_operations"."processor_object_id" is not null;--> statement-breakpoint
CREATE INDEX "live_room_payment_operations_claim_idx" ON "live_room_payment_operations" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "live_room_payment_operations_request_idx" ON "live_room_payment_operations" USING btree ("request_id","operation_type");--> statement-breakpoint
CREATE INDEX "live_room_payment_operations_boost_idx" ON "live_room_payment_operations" USING btree ("request_boost_id","operation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "live_room_processor_events_event_idx" ON "live_room_processor_events" USING btree ("processor","processor_event_id");--> statement-breakpoint
CREATE INDEX "live_room_processor_events_reconcile_idx" ON "live_room_processor_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "live_room_processor_events_payment_idx" ON "live_room_processor_events" USING btree ("payment_id","received_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_request_id_idx" ON "payments" USING btree ("request_id") WHERE "payments"."legacy_unlinked" = false and "payments"."request_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_request_boost_id_idx" ON "payments" USING btree ("request_boost_id") WHERE "payments"."legacy_unlinked" = false and "payments"."request_boost_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_key_idx" ON "payments" USING btree ("idempotency_key") WHERE "payments"."legacy_unlinked" = false and "payments"."idempotency_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "request_boosts_client_request_id_idx" ON "request_boosts" USING btree ("client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "request_boosts_idempotency_key_idx" ON "request_boosts" USING btree ("idempotency_key") WHERE "request_boosts"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "request_boosts_active_gig_idx" ON "request_boosts" USING btree ("gig_id","activated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_idempotency_key_idx" ON "requests" USING btree ("idempotency_key") WHERE "requests"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "requests_active_gig_idx" ON "requests" USING btree ("gig_id","activated_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_durable_action_link" CHECK (
    "payments"."legacy_unlinked"
    or (
      "payments"."performer_id" is not null
      and length(trim("payments"."idempotency_key")) > 0
      and length(trim("payments"."destination_account_id")) > 0
      and (
        ("payments"."action_type" in ('tip', 'request') and "payments"."request_id" is not null and "payments"."request_boost_id" is null)
        or ("payments"."action_type" = 'boost' and "payments"."request_id" is null and "payments"."request_boost_id" is not null)
      )
    )
  );
