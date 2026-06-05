CREATE TYPE "public"."capture_mode" AS ENUM('automatic', 'manual');--> statement-breakpoint
CREATE TYPE "public"."gig_session_status" AS ENUM('draft', 'scheduled', 'active', 'closeout_pending', 'closed', 'expired', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."kyc_status" AS ENUM('not_required', 'required', 'submitted', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('allowed', 'held_for_review', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."payment_account_status" AS ENUM('not_started', 'created', 'charges_enabled', 'payouts_enabled', 'restricted', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('created', 'payment_pending', 'authorized', 'captured', 'voided', 'refunded', 'failed', 'disputed', 'paid_out');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('not_started', 'pending', 'paid_out', 'failed');--> statement-breakpoint
CREATE TYPE "public"."pending_action_status" AS ENUM('pending', 'retrying', 'reconciled', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."performer_onboarding_status" AS ENUM('created', 'profile_started', 'gig_ready', 'payments_limited', 'verification_required', 'verified', 'payouts_enabled', 'restricted', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('not_refunded', 'pending', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('submitted', 'payment_pending', 'payment_authorized', 'held_for_review', 'approved', 'denied', 'voided_or_refunded', 'fulfilled', 'captured', 'paid_out', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('patron', 'performer', 'admin', 'support');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"previous_status" text,
	"next_status" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_request_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"gig_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"status" "pending_action_status" DEFAULT 'pending' NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "gig_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gig_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access_level" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gig_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"performer_id" uuid NOT NULL,
	"status" "gig_session_status" DEFAULT 'draft' NOT NULL,
	"title" text,
	"venue_name" text,
	"started_at" timestamp with time zone,
	"scheduled_end_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"manual_closeout_started_at" timestamp with time zone,
	"manual_closeout_completed_at" timestamp with time zone,
	"auto_closeout_at" timestamp with time zone NOT NULL,
	"auto_closeout_reason" text,
	"closeout_policy" text DEFAULT 'max_started_at_4h_or_scheduled_end_at_30m' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"patron_device_id_hash" text NOT NULL,
	"actor_id" uuid,
	"session_id" text,
	"gig_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"target_entity_type" text,
	"target_entity_id" text,
	"payload_hash" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"first_response_status" integer,
	"first_response_body_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moderation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"status" "moderation_status" NOT NULL,
	"reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"processor" text NOT NULL,
	"processor_event_id" text,
	"event_type" text NOT NULL,
	"previous_status" "payment_status",
	"next_status" "payment_status",
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gig_id" uuid NOT NULL,
	"request_id" uuid,
	"request_boost_id" uuid,
	"payment_status" "payment_status" DEFAULT 'created' NOT NULL,
	"processor" text NOT NULL,
	"processor_payment_intent_id" text,
	"processor_charge_id" text,
	"amount_subtotal" integer NOT NULL,
	"platform_fee" integer DEFAULT 0 NOT NULL,
	"amount_total" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"capture_mode" "capture_mode" DEFAULT 'manual' NOT NULL,
	"refund_status" "refund_status" DEFAULT 'not_refunded' NOT NULL,
	"payout_status" "payout_status" DEFAULT 'not_started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"performer_id" uuid NOT NULL,
	"payment_id" uuid,
	"payout_status" "payout_status" DEFAULT 'not_started' NOT NULL,
	"processor" text,
	"processor_payout_id" text,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performer_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"performer_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "performers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"onboarding_status" "performer_onboarding_status" DEFAULT 'created' NOT NULL,
	"payment_account_status" "payment_account_status" DEFAULT 'not_started' NOT NULL,
	"kyc_status" "kyc_status" DEFAULT 'not_required' NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"lifetime_gross_volume" integer DEFAULT 0 NOT NULL,
	"payout_hold_reason" text,
	"verification_required_at_amount" integer DEFAULT 10000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_boosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"gig_id" uuid NOT NULL,
	"patron_user_id" uuid,
	"status" "request_status" DEFAULT 'submitted' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gig_id" uuid NOT NULL,
	"patron_user_id" uuid,
	"client_request_id" text NOT NULL,
	"status" "request_status" DEFAULT 'submitted' NOT NULL,
	"request_type" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"display_name" text,
	"role" "user_role" DEFAULT 'patron' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_pending_actions" ADD CONSTRAINT "client_pending_actions_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gig_access_grants" ADD CONSTRAINT "gig_access_grants_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gig_access_grants" ADD CONSTRAINT "gig_access_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD CONSTRAINT "gig_sessions_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_events" ADD CONSTRAINT "moderation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_request_boost_id_request_boosts_id_fk" FOREIGN KEY ("request_boost_id") REFERENCES "public"."request_boosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_memberships" ADD CONSTRAINT "performer_memberships_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_memberships" ADD CONSTRAINT "performer_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performers" ADD CONSTRAINT "performers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD CONSTRAINT "request_boosts_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD CONSTRAINT "request_boosts_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD CONSTRAINT "request_boosts_patron_user_id_users_id_fk" FOREIGN KEY ("patron_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_patron_user_id_users_id_fk" FOREIGN KEY ("patron_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "client_pending_actions_client_request_id_idx" ON "client_pending_actions" USING btree ("client_request_id");--> statement-breakpoint
CREATE INDEX "client_pending_actions_idempotency_key_idx" ON "client_pending_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "client_pending_actions_expires_at_idx" ON "client_pending_actions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gig_access_grants_gig_user_idx" ON "gig_access_grants" USING btree ("gig_id","user_id");--> statement-breakpoint
CREATE INDEX "gig_sessions_performer_status_idx" ON "gig_sessions" USING btree ("performer_id","status");--> statement-breakpoint
CREATE INDEX "gig_sessions_auto_closeout_at_idx" ON "gig_sessions" USING btree ("auto_closeout_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_key_idx" ON "idempotency_keys" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_intent_fingerprint_idx" ON "idempotency_keys" USING btree ("intent_fingerprint");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expires_at_idx" ON "idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "moderation_events_entity_idx" ON "moderation_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_idx" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_processor_event_idx" ON "payment_events" USING btree ("processor_event_id");--> statement-breakpoint
CREATE INDEX "payments_gig_status_idx" ON "payments" USING btree ("gig_id","payment_status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_processor_payment_intent_idx" ON "payments" USING btree ("processor_payment_intent_id");--> statement-breakpoint
CREATE INDEX "payouts_performer_status_idx" ON "payouts" USING btree ("performer_id","payout_status");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_memberships_performer_user_idx" ON "performer_memberships" USING btree ("performer_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "performers_handle_idx" ON "performers" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "performers_owner_user_id_idx" ON "performers" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "request_boosts_request_id_idx" ON "request_boosts" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_boosts_gig_id_idx" ON "request_boosts" USING btree ("gig_id");--> statement-breakpoint
CREATE INDEX "requests_gig_status_idx" ON "requests" USING btree ("gig_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_client_request_id_idx" ON "requests" USING btree ("client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");