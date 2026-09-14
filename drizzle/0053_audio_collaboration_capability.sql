-- Minimal capability authority required by private collaborator revision uploads.
-- Ported unchanged from sway-roadmap-wave4 at 22c6c5da582b686abd5d99cec60c47b8e600da98:
-- 0037_talent_capability_foundation.sql and the current-capability helper in 0039.
-- This creates no grants and changes no public discovery or money permissions.

CREATE TYPE "public"."performer_capability" AS ENUM('profile_publication', 'public_discovery', 'non_money_inquiries', 'live_rooms', 'live_money', 'event_publication', 'external_ticket_links', 'native_ticket_sales', 'private_collaboration', 'release_preparation', 'audio_publication', 'audio_sales', 'dsp_delivery', 'royalty_processing', 'partnership_inquiries', 'service_inquiries');
--> statement-breakpoint
CREATE TYPE "public"."performer_capability_decision" AS ENUM('granted', 'revoked', 'expired', 'denied');
--> statement-breakpoint
CREATE TABLE "performer_capability_grant_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_sequence" bigserial NOT NULL,
	"performer_id" uuid NOT NULL,
	"capability" "performer_capability" NOT NULL,
	"decision" "performer_capability_decision" NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"idempotency_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_capability_grant_events_actor_shape_valid" CHECK ((
    ("performer_capability_grant_events"."actor_type" = 'admin' and "performer_capability_grant_events"."actor_user_id" is not null)
    or
    ("performer_capability_grant_events"."actor_type" = 'system' and "performer_capability_grant_events"."actor_user_id" is null)
  )),
	CONSTRAINT "performer_capability_grant_events_reason_valid" CHECK (length(trim("performer_capability_grant_events"."reason")) between 1 and 500),
	CONSTRAINT "performer_capability_grant_events_evidence_required" CHECK (jsonb_typeof("performer_capability_grant_events"."evidence") = 'object' and "performer_capability_grant_events"."evidence" <> '{}'::jsonb),
	CONSTRAINT "performer_capability_grant_events_expiry_valid" CHECK ((
    ("performer_capability_grant_events"."decision" = 'granted' and ("performer_capability_grant_events"."expires_at" is null or "performer_capability_grant_events"."expires_at" > "performer_capability_grant_events"."created_at"))
    or
    ("performer_capability_grant_events"."decision" <> 'granted' and "performer_capability_grant_events"."expires_at" is null)
  )),
	CONSTRAINT "performer_capability_grant_events_idempotency_hash_valid" CHECK ("performer_capability_grant_events"."idempotency_key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "performer_capability_grant_events" ADD CONSTRAINT "performer_capability_grant_events_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "performer_capability_grant_events_sequence_idx" ON "performer_capability_grant_events" USING btree ("event_sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "performer_capability_grant_events_idempotency_idx" ON "performer_capability_grant_events" USING btree ("idempotency_key_hash");
--> statement-breakpoint
CREATE INDEX "performer_capability_grant_events_current_idx" ON "performer_capability_grant_events" USING btree ("performer_id","capability","event_sequence");
--> statement-breakpoint
CREATE FUNCTION "sway_reject_wave1_immutable_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Sway Wave 1 identity, intent, grant, authority, attribution, and growth records are append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_require_wave1_decision_actor"(decision_actor_type text, decision_actor_user_id uuid) RETURNS void AS $$
DECLARE
  actor_role text;
BEGIN
  IF decision_actor_type = 'system' THEN
    IF decision_actor_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'System decisions may not impersonate a user.';
    END IF;
    RETURN;
  END IF;

  IF decision_actor_type <> 'admin' OR decision_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'Capability and authority decisions require an admin or system actor.';
  END IF;
  SELECT role::text INTO actor_role FROM users WHERE id = decision_actor_user_id;
  IF actor_role IS NULL OR actor_role NOT IN ('admin', 'support') THEN
    RAISE EXCEPTION 'Capability and authority decisions require persisted admin access.';
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_performer_capability_decision"() RETURNS trigger AS $$
DECLARE
  latest_decision performer_capability_decision;
  latest_expiry timestamptz;
  latest_is_active boolean;
BEGIN
  PERFORM 1 FROM performers WHERE id = NEW.performer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Capability decisions require an existing performer.';
  END IF;
  PERFORM sway_require_wave1_decision_actor(NEW.actor_type, NEW.actor_user_id);
  NEW.event_sequence := nextval(pg_get_serial_sequence('performer_capability_grant_events', 'event_sequence'));

  SELECT decision, expires_at INTO latest_decision, latest_expiry
  FROM performer_capability_grant_events
  WHERE performer_id = NEW.performer_id AND capability = NEW.capability
  ORDER BY event_sequence DESC
  LIMIT 1;

  latest_is_active := latest_decision = 'granted'
    AND (latest_expiry IS NULL OR latest_expiry > NEW.created_at);

  IF NEW.decision = 'granted' AND latest_is_active THEN
    RAISE EXCEPTION 'An active capability grant must be revoked or expired before another grant.';
  ELSIF NEW.decision = 'revoked' AND NOT coalesce(latest_is_active, false) THEN
    RAISE EXCEPTION 'Only the latest active capability grant may be revoked or expired.';
  ELSIF NEW.decision = 'expired' AND (
    latest_decision IS DISTINCT FROM 'granted'
    OR latest_expiry IS NULL
    OR latest_expiry > NEW.created_at
  ) THEN
    RAISE EXCEPTION 'A capability grant cannot expire before its recorded expiry.';
  ELSIF NEW.decision = 'denied' AND latest_is_active THEN
    RAISE EXCEPTION 'An active capability grant must be revoked, not overwritten by a denial.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "performer_capability_grant_events_validate"
BEFORE INSERT ON "performer_capability_grant_events"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_performer_capability_decision"();
--> statement-breakpoint
CREATE TRIGGER "performer_capability_grant_events_append_only"
BEFORE UPDATE OR DELETE ON "performer_capability_grant_events"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_wave1_immutable_mutation"();
--> statement-breakpoint
CREATE FUNCTION "sway_require_current_performer_capability"(
  subject_performer_id uuid,
  required_capability performer_capability
) RETURNS void AS $$
DECLARE
  latest_decision performer_capability_decision;
  latest_expiry timestamptz;
BEGIN
  PERFORM 1 FROM performers WHERE id = subject_performer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Consequential talent action requires an existing performer.' USING ERRCODE = '42501';
  END IF;

  SELECT grant_event.decision, grant_event.expires_at
    INTO latest_decision, latest_expiry
  FROM performer_capability_grant_events grant_event
  WHERE grant_event.performer_id = subject_performer_id
    AND grant_event.capability = required_capability
  ORDER BY grant_event.event_sequence DESC
  LIMIT 1;

  IF latest_decision IS DISTINCT FROM 'granted'
    OR (latest_expiry IS NOT NULL AND latest_expiry <= clock_timestamp()) THEN
    RAISE EXCEPTION 'Current % capability authorization is required.', required_capability USING ERRCODE = '42501';
  END IF;
END;
$$ LANGUAGE plpgsql;
