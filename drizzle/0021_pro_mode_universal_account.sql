CREATE TYPE "public"."pro_mode_status" AS ENUM('disabled', 'onboarding', 'active', 'suspended', 'revoked');--> statement-breakpoint
CREATE TABLE "pro_mode_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"previous_status" text,
	"next_status" text NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pro_mode_status_events_next_status_allowed" CHECK ("pro_mode_status_events"."next_status" in ('disabled', 'onboarding', 'active', 'suspended', 'revoked'))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pro_mode_status" "pro_mode_status" DEFAULT 'disabled' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "pro_mode_status_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pro_mode_status_events" ADD CONSTRAINT "pro_mode_status_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pro_mode_status_events" ADD CONSTRAINT "pro_mode_status_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pro_mode_status_events_user_created_idx" ON "pro_mode_status_events" USING btree ("user_id","created_at");--> statement-breakpoint

-- Existing performer accounts already completed performer signup before this
-- migration existed; they must not silently land on the universal 'disabled'
-- default. Map their current onboarding/suspension state onto pro_mode_status
-- so the new column reflects reality instead of erasing it.
UPDATE "users"
SET
  "pro_mode_status" = CASE
    WHEN performer."onboarding_status" = 'suspended' THEN 'suspended'::pro_mode_status
    WHEN performer."onboarding_status" IN ('created', 'profile_started') THEN 'onboarding'::pro_mode_status
    ELSE 'active'::pro_mode_status
  END,
  "pro_mode_status_changed_at" = now()
FROM "performers" performer
WHERE performer."owner_user_id" = "users"."id";
--> statement-breakpoint

-- Every status must have a causal event, including this one-time backfill,
-- so the audit trail has no unexplained gaps for pre-existing accounts.
INSERT INTO "pro_mode_status_events" ("user_id", "previous_status", "next_status", "reason", "actor_user_id", "created_at")
SELECT
  "users"."id",
  'disabled',
  "users"."pro_mode_status"::text,
  'Backfilled during pro_mode_universal_account migration for existing performer account.',
  "users"."id",
  now()
FROM "users"
INNER JOIN "performers" performer ON performer."owner_user_id" = "users"."id";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "sway_reject_immutable_pro_mode_status_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Sway Pro Mode status events are append-only';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "pro_mode_status_events_immutable"
  BEFORE UPDATE OR DELETE ON "pro_mode_status_events"
  FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_pro_mode_status_event_mutation"();