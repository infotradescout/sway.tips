CREATE TYPE "public"."live_room_type" AS ENUM('music', 'comedy', 'service', 'general');--> statement-breakpoint
CREATE TYPE "public"."performer_event_attendance_mode" AS ENUM('walk_in', 'external_rsvp', 'external_ticket', 'native_ticket');--> statement-breakpoint
CREATE TABLE "live_room_money_release_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_sequence" bigserial NOT NULL,
	"environment" text NOT NULL,
	"decision" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"idempotency_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_room_money_release_events_environment_allowed" CHECK ("live_room_money_release_events"."environment" in ('test', 'live')),
	CONSTRAINT "live_room_money_release_events_decision_allowed" CHECK ("live_room_money_release_events"."decision" in ('enabled', 'disabled')),
	CONSTRAINT "live_room_money_release_events_reason_valid" CHECK (length(trim("live_room_money_release_events"."reason")) between 1 and 500),
	CONSTRAINT "live_room_money_release_events_evidence_required" CHECK (jsonb_typeof("live_room_money_release_events"."evidence") = 'object' and "live_room_money_release_events"."evidence" <> '{}'::jsonb),
	CONSTRAINT "live_room_money_release_events_expiry_valid" CHECK (("live_room_money_release_events"."decision" = 'enabled' and ("live_room_money_release_events"."expires_at" is null or "live_room_money_release_events"."expires_at" > "live_room_money_release_events"."created_at")) or ("live_room_money_release_events"."decision" = 'disabled' and "live_room_money_release_events"."expires_at" is null)),
	CONSTRAINT "live_room_money_release_events_idempotency_hash_valid" CHECK ("live_room_money_release_events"."idempotency_key_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
ALTER TABLE "performer_events" DROP CONSTRAINT "performer_events_published_has_external_ticket";--> statement-breakpoint
ALTER TABLE "performer_authority_events" DROP CONSTRAINT "performer_authority_events_subject_id_valid";--> statement-breakpoint
ALTER TABLE "performer_authority_events" ADD CONSTRAINT "performer_authority_events_subject_id_valid" CHECK ("performer_authority_events"."subject_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$');--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD COLUMN "room_type" "live_room_type" DEFAULT 'music' NOT NULL;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD COLUMN "money_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD COLUMN "money_destination_account_id" text;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD COLUMN "money_environment" text;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD COLUMN "linked_event_id" uuid;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD COLUMN "request_menu" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_events" ADD COLUMN "attendance_mode" "performer_event_attendance_mode" DEFAULT 'external_ticket' NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_events" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "moderation_events" ADD COLUMN "reporter_fingerprint" text;--> statement-breakpoint
ALTER TABLE "moderation_events" ADD COLUMN "requester_ip_hash" text;--> statement-breakpoint
ALTER TABLE "moderation_events" ADD COLUMN "report_window_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_events" ADD COLUMN "retention_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "money_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD COLUMN "money_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD COLUMN "minimum_executor_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD COLUMN "lease_executor_generation" integer;--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD CONSTRAINT "live_room_payment_operations_min_executor_generation_valid" CHECK ("minimum_executor_generation" >= 1);--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD CONSTRAINT "live_room_payment_operations_lease_executor_generation_valid" CHECK ("lease_executor_generation" IS NULL OR "lease_executor_generation" >= 1);--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD CONSTRAINT "live_room_payment_operations_released_executor_generation" CHECK ("status" = 'leased' OR "lease_executor_generation" IS NULL);--> statement-breakpoint
ALTER TABLE "live_room_money_release_events" ADD CONSTRAINT "live_room_money_release_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_room_money_release_events_sequence_idx" ON "live_room_money_release_events" USING btree ("event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "live_room_money_release_events_idempotency_idx" ON "live_room_money_release_events" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "live_room_money_release_events_current_idx" ON "live_room_money_release_events" USING btree ("environment","event_sequence");--> statement-breakpoint
UPDATE "gig_sessions" room
SET
  "money_enabled" = true,
  "money_destination_account_id" = CASE
    WHEN room."runtime_session_state"->>'settlementMode' = 'platform_test_balance'
      AND room."runtime_session_state"->>'paymentEnvironment' = 'test'
      THEN 'sway_test_platform_balance'
    ELSE performer."stripe_connected_account_id"
  END,
  "money_environment" = room."runtime_session_state"->>'paymentEnvironment'
FROM "performers" performer
WHERE room."performer_id" = performer."id"
  AND room."room_type" = 'music'
  AND (
    room."runtime_session_state"->>'paymentsEnabled' = 'true'
    OR room."runtime_session_state"->>'tipsEnabled' = 'true'
  )
  AND room."runtime_session_state"->>'paymentEnvironment' IN ('test', 'live')
  AND (
    (
      room."runtime_session_state"->>'settlementMode' = 'platform_test_balance'
      AND room."runtime_session_state"->>'paymentEnvironment' = 'test'
    )
    OR nullif(trim(performer."stripe_connected_account_id"), '') IS NOT NULL
  );--> statement-breakpoint
UPDATE "performer_events"
SET "attendance_mode" = CASE
  WHEN "ticketing_mode" = 'native_ga' THEN 'native_ticket'::"performer_event_attendance_mode"
  WHEN "external_ticket_label" = 'RSVP' THEN 'external_rsvp'::"performer_event_attendance_mode"
  ELSE 'external_ticket'::"performer_event_attendance_mode"
END;--> statement-breakpoint
CREATE FUNCTION "sway_sync_legacy_performer_event_attendance_mode"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.ticketing_mode = 'native_ga' THEN
      NEW.attendance_mode := 'native_ticket'::performer_event_attendance_mode;
    ELSIF NEW.external_ticket_label = 'RSVP' THEN
      NEW.attendance_mode := 'external_rsvp'::performer_event_attendance_mode;
    END IF;
  ELSIF NEW.attendance_mode IS NOT DISTINCT FROM OLD.attendance_mode
    AND (
      NEW.ticketing_mode IS DISTINCT FROM OLD.ticketing_mode
      OR NEW.external_ticket_label IS DISTINCT FROM OLD.external_ticket_label
      OR NEW.external_ticket_url IS DISTINCT FROM OLD.external_ticket_url
    ) THEN
    IF NEW.ticketing_mode = 'native_ga' THEN
      NEW.attendance_mode := 'native_ticket'::performer_event_attendance_mode;
    ELSIF NEW.external_ticket_label = 'RSVP' THEN
      NEW.attendance_mode := 'external_rsvp'::performer_event_attendance_mode;
    ELSE
      NEW.attendance_mode := 'external_ticket'::performer_event_attendance_mode;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "performer_events_legacy_attendance_mode_sync"
BEFORE INSERT OR UPDATE OF "ticketing_mode", "external_ticket_label", "external_ticket_url", "attendance_mode"
ON "performer_events"
FOR EACH ROW EXECUTE FUNCTION "sway_sync_legacy_performer_event_attendance_mode"();--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD CONSTRAINT "gig_sessions_linked_event_owner_fk" FOREIGN KEY ("linked_event_id","performer_id") REFERENCES "public"."performer_events"("id","performer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gig_sessions_active_linked_event_idx" ON "gig_sessions" USING btree ("linked_event_id") WHERE "gig_sessions"."linked_event_id" is not null and "gig_sessions"."status" in ('active', 'closeout_pending');--> statement-breakpoint
CREATE INDEX "moderation_events_report_window_idx" ON "moderation_events" USING btree ("entity_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_events_dedupe_key_idx" ON "moderation_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_events_room_menu_report_identity_idx" ON "moderation_events" USING btree ("entity_id","reporter_fingerprint","report_window_started_at") WHERE "moderation_events"."entity_type" = 'room_menu_item_report';--> statement-breakpoint
CREATE INDEX "moderation_events_room_menu_report_reporter_window_idx" ON "moderation_events" USING btree ("reporter_fingerprint","report_window_started_at") WHERE "moderation_events"."entity_type" = 'room_menu_item_report';--> statement-breakpoint
CREATE INDEX "moderation_events_room_menu_report_ip_window_idx" ON "moderation_events" USING btree ("requester_ip_hash","report_window_started_at") WHERE "moderation_events"."entity_type" = 'room_menu_item_report';--> statement-breakpoint
CREATE INDEX "moderation_events_room_menu_report_entity_window_idx" ON "moderation_events" USING btree ("entity_id","report_window_started_at") WHERE "moderation_events"."entity_type" = 'room_menu_item_report';--> statement-breakpoint
CREATE INDEX "moderation_events_room_menu_report_expiry_idx" ON "moderation_events" USING btree ("retention_expires_at") WHERE "moderation_events"."entity_type" = 'room_menu_item_report';--> statement-breakpoint
ALTER TABLE "moderation_events" ADD CONSTRAINT "moderation_events_room_menu_report_shape" CHECK ((
  "entity_type" <> 'room_menu_item_report'
  AND "reporter_fingerprint" IS NULL
  AND "requester_ip_hash" IS NULL
  AND "report_window_started_at" IS NULL
  AND "retention_expires_at" IS NULL
) OR (
  "entity_type" = 'room_menu_item_report'
  AND "reporter_fingerprint" ~ '^[0-9a-f]{64}$'
  AND "requester_ip_hash" ~ '^[0-9a-f]{64}$'
  AND "status" = 'held_for_review'
  AND "reason" IS NOT NULL
  AND length(trim("reason")) BETWEEN 1 AND 500
  AND jsonb_typeof("metadata") = 'object'
  AND octet_length("metadata"::text) <= 4096
  AND length(coalesce("metadata"->>'details', '')) <= 2000
  AND "report_window_started_at" IS NOT NULL
  AND "retention_expires_at" > "created_at"
  AND "retention_expires_at" <= "created_at" + interval '180 days'
));--> statement-breakpoint
CREATE FUNCTION "sway_request_menu_is_valid"(menu jsonb, room_kind live_room_type) RETURNS boolean AS $$
BEGIN
  IF jsonb_typeof(menu) <> 'array'
    OR jsonb_array_length(menu) > 8
    OR octet_length(menu::text) > 24576 THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(menu) item
    WHERE jsonb_typeof(item) <> 'object'
      OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(item) key)
        IS DISTINCT FROM ARRAY['description', 'id', 'targetType', 'title']::text[]
      OR coalesce(item->>'id', '') !~ '^[a-z0-9_-]{1,64}$'
      OR length(trim(coalesce(item->>'title', ''))) NOT BETWEEN 1 AND 80
      OR length(trim(coalesce(item->>'description', ''))) NOT BETWEEN 1 AND 240
      OR coalesce(item->>'targetType', '') NOT IN ('music', 'custom')
      OR (room_kind <> 'music' AND item->>'targetType' <> 'custom')
  ) THEN
    RETURN false;
  END IF;
  RETURN (
    SELECT count(*) = count(DISTINCT item->>'id')
    FROM jsonb_array_elements(menu) item
  );
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD CONSTRAINT "gig_sessions_request_menu_shape" CHECK (sway_request_menu_is_valid("request_menu", "room_type"));--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD CONSTRAINT "gig_sessions_money_requires_music" CHECK ((
  "money_enabled" = false
  AND "money_destination_account_id" IS NULL
  AND "money_environment" IS NULL
) OR (
  "money_enabled" = true
  AND "room_type" = 'music'
  AND "money_destination_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$'
  AND "money_environment" IN ('test', 'live')
));--> statement-breakpoint
CREATE FUNCTION "sway_enforce_live_room_money_mode"() RETURNS trigger AS $$
DECLARE
  requires_money boolean;
  room_money_enabled boolean;
  room_kind live_room_type;
  room_destination_account_id text;
  room_money_environment text;
BEGIN
  IF TG_TABLE_NAME = 'idempotency_keys' THEN
    requires_money := NEW.amount_cents > 0 AND NEW.action_type <> 'boost';
  ELSIF TG_TABLE_NAME = 'requests' THEN
    requires_money := NEW.money_required OR NEW.amount_cents > 0;
  ELSIF TG_TABLE_NAME = 'request_boosts' THEN
    requires_money := NEW.money_required OR (
      NEW.amount_cents > 0
      AND coalesce(NEW.runtime_boost_state->>'paymentStatus', '') <> 'not_applicable'
    );
  ELSIF TG_TABLE_NAME = 'payments' THEN
    requires_money := NEW.amount_subtotal > 0 OR NEW.amount_total > 0;
  ELSE
    RAISE EXCEPTION 'Unsupported live-room money guard table: %', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;

  IF NOT requires_money THEN
    RETURN NEW;
  END IF;

  SELECT room.money_enabled, room.room_type, room.money_destination_account_id, room.money_environment
    INTO room_money_enabled, room_kind, room_destination_account_id, room_money_environment
  FROM gig_sessions room
  WHERE room.id = NEW.gig_id;

  IF NOT FOUND OR room_money_enabled IS DISTINCT FROM true OR room_kind IS DISTINCT FROM 'music' THEN
    RAISE EXCEPTION 'Live-room money is not enabled for this room.' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'payments' THEN
    IF NEW.destination_account_id IS DISTINCT FROM room_destination_account_id THEN
      RAISE EXCEPTION 'Payment destination does not match the room money authority.' USING ERRCODE = '42501';
    END IF;
  END IF;
  PERFORM sway_require_current_live_room_money_authority(
    NEW.gig_id,
    room_destination_account_id,
    room_money_environment
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "idempotency_keys_00_money_mode_guard"
BEFORE INSERT OR UPDATE OF "gig_id", "amount_cents"
ON "idempotency_keys"
FOR EACH ROW EXECUTE FUNCTION "sway_enforce_live_room_money_mode"();--> statement-breakpoint
CREATE TRIGGER "requests_00_money_mode_guard"
BEFORE INSERT OR UPDATE OF "gig_id", "amount_cents", "money_required"
ON "requests"
FOR EACH ROW EXECUTE FUNCTION "sway_enforce_live_room_money_mode"();--> statement-breakpoint
CREATE TRIGGER "request_boosts_00_money_mode_guard"
BEFORE INSERT OR UPDATE OF "gig_id", "amount_cents", "money_required"
ON "request_boosts"
FOR EACH ROW EXECUTE FUNCTION "sway_enforce_live_room_money_mode"();--> statement-breakpoint
CREATE TRIGGER "payments_00_money_mode_guard"
BEFORE INSERT OR UPDATE OF "gig_id", "amount_subtotal", "amount_total"
ON "payments"
FOR EACH ROW EXECUTE FUNCTION "sway_enforce_live_room_money_mode"();--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_published_attendance_ready" CHECK ("performer_events"."status" <> 'published' OR "performer_events"."attendance_mode" IN ('walk_in', 'native_ticket') OR "performer_events"."external_ticket_url" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_published_walk_in_has_location" CHECK ("performer_events"."status" <> 'published' OR "performer_events"."attendance_mode" <> 'walk_in' OR (
      "performer_events"."location_is_tba" = false
      AND "performer_events"."location_name" IS NOT NULL
      AND length(trim("performer_events"."location_name")) > 0
      AND (
        ("performer_events"."location_address" IS NOT NULL AND length(trim("performer_events"."location_address")) > 0)
        OR ("performer_events"."city" IS NOT NULL AND length(trim("performer_events"."city")) > 0)
      )
    ));--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_attendance_mode_shape" CHECK ((
      "performer_events"."attendance_mode" = 'walk_in'
      AND "performer_events"."ticketing_mode" = 'external'
      AND "performer_events"."external_ticket_url" IS NULL
      AND "performer_events"."external_ticket_label" IS NULL
    ) OR (
      "performer_events"."attendance_mode" = 'external_rsvp'
      AND "performer_events"."ticketing_mode" = 'external'
      AND (
        ("performer_events"."external_ticket_url" IS NULL AND "performer_events"."external_ticket_label" IS NULL)
        OR ("performer_events"."external_ticket_url" IS NOT NULL AND "performer_events"."external_ticket_label" = 'RSVP')
      )
    ) OR (
      "performer_events"."attendance_mode" = 'external_ticket'
      AND "performer_events"."ticketing_mode" = 'external'
      AND (
        ("performer_events"."external_ticket_url" IS NULL AND "performer_events"."external_ticket_label" IS NULL)
        OR ("performer_events"."external_ticket_url" IS NOT NULL AND "performer_events"."external_ticket_label" IN ('Get tickets', 'View details'))
      )
    ) OR (
      "performer_events"."attendance_mode" = 'native_ticket'
      AND "performer_events"."ticketing_mode" = 'native_ga'
      AND "performer_events"."external_ticket_url" IS NULL
      AND "performer_events"."external_ticket_label" IS NULL
    ));--> statement-breakpoint
INSERT INTO "performer_capability_grant_events" (
  "performer_id", "capability", "decision", "actor_type", "actor_user_id",
  "reason", "evidence", "idempotency_key_hash"
)
SELECT
  p."id",
  baseline."capability"::performer_capability,
  'granted'::performer_capability_decision,
  'system',
  NULL,
  'Wave 4 baseline authorization for a non-money professional capability.',
  jsonb_build_object(
    'reference', 'wave4-baseline-nonmoney-capability',
    'policyVersion', 'wave4',
    'capability', baseline."capability"
  ),
  md5('wave4-baseline:' || p."id"::text || ':' || baseline."capability")
    || md5('wave4-baseline-proof:' || p."id"::text || ':' || baseline."capability")
FROM "performers" p
CROSS JOIN (VALUES
  ('live_rooms'),
  ('event_publication'),
  ('external_ticket_links')
) AS baseline("capability")
WHERE NOT EXISTS (
  SELECT 1
  FROM "performer_capability_grant_events" history
  WHERE history."performer_id" = p."id"
    AND history."capability" = baseline."capability"::performer_capability
);--> statement-breakpoint
CREATE FUNCTION "sway_grant_wave4_baseline_capabilities"() RETURNS trigger AS $$
BEGIN
  INSERT INTO performer_capability_grant_events (
    performer_id, capability, decision, actor_type, actor_user_id,
    reason, evidence, idempotency_key_hash
  )
  SELECT
    NEW.id,
    baseline.capability::performer_capability,
    'granted'::performer_capability_decision,
    'system',
    NULL,
    'Wave 4 baseline authorization for a non-money professional capability.',
    jsonb_build_object(
      'reference', 'wave4-baseline-nonmoney-capability',
      'policyVersion', 'wave4',
      'capability', baseline.capability
    ),
    md5('wave4-baseline:' || NEW.id::text || ':' || baseline.capability)
      || md5('wave4-baseline-proof:' || NEW.id::text || ':' || baseline.capability)
  FROM (VALUES
    ('live_rooms'),
    ('event_publication'),
    ('external_ticket_links')
  ) AS baseline(capability);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "performers_wave4_baseline_capabilities"
AFTER INSERT ON "performers"
FOR EACH ROW EXECUTE FUNCTION "sway_grant_wave4_baseline_capabilities"();--> statement-breakpoint
INSERT INTO "performer_authority_events" (
  "performer_id", "authority_kind", "subject_type", "subject_id", "decision",
  "actor_type", "actor_user_id", "reason", "evidence", "idempotency_key_hash"
)
SELECT
  event."performer_id",
  'event_organizer'::performer_authority_kind,
  'event',
  event."id"::text,
  'granted'::performer_capability_decision,
  'system',
  NULL,
  'Exact organizer authority derived from durable performer event ownership.',
  jsonb_build_object(
    'reference', 'performer-event-owner:' || event."id"::text,
    'policyVersion', 'wave4'
  ),
  md5('wave4-event-owner:' || event."id"::text)
    || md5('wave4-event-owner-proof:' || event."id"::text)
FROM "performer_events" event
WHERE NOT EXISTS (
  SELECT 1
  FROM "performer_authority_events" history
  WHERE history."performer_id" = event."performer_id"
    AND history."authority_kind" = 'event_organizer'
    AND history."subject_type" = 'event'
    AND history."subject_id" = event."id"::text
);--> statement-breakpoint
CREATE FUNCTION "sway_grant_event_owner_organizer_authority"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM performer_authority_events history
    WHERE history.performer_id = NEW.performer_id
      AND history.authority_kind = 'event_organizer'
      AND history.subject_type = 'event'
      AND history.subject_id = NEW.id::text
  ) THEN
    INSERT INTO performer_authority_events (
      performer_id, authority_kind, subject_type, subject_id, decision,
      actor_type, actor_user_id, reason, evidence, idempotency_key_hash
    ) VALUES (
      NEW.performer_id,
      'event_organizer',
      'event',
      NEW.id::text,
      'granted',
      'system',
      NULL,
      'Exact organizer authority derived from durable performer event ownership.',
      jsonb_build_object(
        'reference', 'performer-event-owner:' || NEW.id::text,
        'policyVersion', 'wave4'
      ),
      md5('wave4-event-owner:' || NEW.id::text)
        || md5('wave4-event-owner-proof:' || NEW.id::text)
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "performer_events_10_grant_owner_authority"
AFTER INSERT ON "performer_events"
FOR EACH ROW EXECUTE FUNCTION "sway_grant_event_owner_organizer_authority"();--> statement-breakpoint
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
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE FUNCTION "sway_require_current_event_organizer_authority"(
  subject_performer_id uuid,
  subject_event_id uuid
) RETURNS void AS $$
DECLARE
  latest_decision performer_capability_decision;
  latest_expiry timestamptz;
BEGIN
  PERFORM 1 FROM performers WHERE id = subject_performer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Event authority requires an existing performer.' USING ERRCODE = '42501';
  END IF;

  SELECT authority_event.decision, authority_event.expires_at
    INTO latest_decision, latest_expiry
  FROM performer_authority_events authority_event
  WHERE authority_event.performer_id = subject_performer_id
    AND authority_event.authority_kind = 'event_organizer'
    AND authority_event.subject_type = 'event'
    AND authority_event.subject_id = subject_event_id::text
  ORDER BY authority_event.event_sequence DESC
  LIMIT 1;

  IF latest_decision IS DISTINCT FROM 'granted'
    OR (latest_expiry IS NOT NULL AND latest_expiry <= clock_timestamp()) THEN
    RAISE EXCEPTION 'Current organizer authority for this exact event is required.' USING ERRCODE = '42501';
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE FUNCTION "sway_live_money_authority_lock"(subject_performer_id uuid) RETURNS void AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('sway:live-money:' || subject_performer_id::text, 0));
$$ LANGUAGE sql VOLATILE STRICT;--> statement-breakpoint
CREATE FUNCTION "sway_live_money_release_lock"(subject_environment text) RETURNS void AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('sway:live-money-release:' || subject_environment, 0));
$$ LANGUAGE sql VOLATILE STRICT;--> statement-breakpoint
CREATE FUNCTION "sway_live_money_release_admission_lock"(subject_environment text) RETURNS void AS $$
  SELECT pg_advisory_xact_lock_shared(hashtextextended('sway:live-money-release:' || subject_environment, 0));
$$ LANGUAGE sql VOLATILE STRICT;--> statement-breakpoint
CREATE FUNCTION "sway_require_current_performer_authority"(
  subject_performer_id uuid,
  required_authority performer_authority_kind,
  required_subject_type text,
  required_subject_id text
) RETURNS void AS $$
DECLARE
  latest_decision performer_capability_decision;
  latest_expiry timestamptz;
BEGIN
  SELECT authority_event.decision, authority_event.expires_at
    INTO latest_decision, latest_expiry
  FROM performer_authority_events authority_event
  WHERE authority_event.performer_id = subject_performer_id
    AND authority_event.authority_kind = required_authority
    AND authority_event.subject_type = required_subject_type
    AND authority_event.subject_id = required_subject_id
  ORDER BY authority_event.event_sequence DESC
  LIMIT 1;

  IF latest_decision IS DISTINCT FROM 'granted'
    OR (latest_expiry IS NOT NULL AND latest_expiry <= clock_timestamp()) THEN
    RAISE EXCEPTION 'Current % authority for exact % % is required.', required_authority, required_subject_type, required_subject_id USING ERRCODE = '42501';
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE FUNCTION "sway_require_current_live_money_authority"(
  subject_performer_id uuid,
  expected_destination_account_id text,
  expected_environment text
) RETURNS void AS $$
DECLARE
  seller performers%ROWTYPE;
  evaluated_at timestamptz;
  release_decision text;
  release_expiry timestamptz;
  capability_decision performer_capability_decision;
  capability_expiry timestamptz;
  seller_decision performer_capability_decision;
  seller_expiry timestamptz;
  payout_decision performer_capability_decision;
  payout_expiry timestamptz;
BEGIN
  IF nullif(trim(expected_destination_account_id), '') IS NULL THEN
    RAISE EXCEPTION 'An exact payout destination is required for live money.' USING ERRCODE = '42501';
  END IF;
  IF expected_environment NOT IN ('test', 'live') THEN
    RAISE EXCEPTION 'An exact test or live money environment is required.' USING ERRCODE = '42501';
  END IF;
  SELECT performer.* INTO seller
  FROM performers performer
  WHERE performer.id = subject_performer_id
  FOR UPDATE;
  IF NOT FOUND
    OR seller.is_active IS DISTINCT FROM true
    OR seller.onboarding_status IN ('restricted', 'suspended')
    OR seller.payout_hold_reason IS NOT NULL THEN
    RAISE EXCEPTION 'Seller is not eligible for live money.' USING ERRCODE = '42501';
  END IF;
  IF expected_destination_account_id = 'sway_test_platform_balance' THEN
    IF expected_environment <> 'test' THEN
      RAISE EXCEPTION 'Platform-balance rehearsal is test-only.' USING ERRCODE = '42501';
    END IF;
  ELSIF seller.stripe_connected_account_id IS DISTINCT FROM expected_destination_account_id
    OR seller.payment_account_status IS DISTINCT FROM 'payouts_enabled'
    OR seller.kyc_status NOT IN ('not_required', 'verified')
    OR seller.charges_enabled IS DISTINCT FROM true
    OR seller.payouts_enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Connected-account seller readiness is not current.' USING ERRCODE = '42501';
  END IF;

  -- Performer-row authority is acquired before the shared environment release
  -- lock. Unrelated performers can enter provider execution concurrently,
  -- while a release mutation takes the exclusive form and waits for every
  -- admitted provider boundary to finish.
  -- Capability/authority inserts take a foreign-key KEY SHARE lock on this
  -- same performer row, so revocations serialize with the provider boundary
  -- without mixing advisory and row locks in opposite orders.
  PERFORM sway_live_money_release_admission_lock(expected_environment);
  evaluated_at := clock_timestamp();

  SELECT release_event.decision, release_event.expires_at
    INTO release_decision, release_expiry
  FROM live_room_money_release_events release_event
  WHERE release_event.environment = expected_environment
  ORDER BY release_event.event_sequence DESC
  LIMIT 1;
  IF release_decision IS DISTINCT FROM 'enabled'
    OR (release_expiry IS NOT NULL AND release_expiry <= evaluated_at) THEN
    RAISE EXCEPTION 'Durable % live-money release authorization is required.', expected_environment USING ERRCODE = '42501';
  END IF;

  SELECT grant_event.decision, grant_event.expires_at
    INTO capability_decision, capability_expiry
  FROM performer_capability_grant_events grant_event
  WHERE grant_event.performer_id = subject_performer_id
    AND grant_event.capability = 'live_money'
  ORDER BY grant_event.event_sequence DESC
  LIMIT 1;
  IF capability_decision IS DISTINCT FROM 'granted'
    OR (capability_expiry IS NOT NULL AND capability_expiry <= evaluated_at) THEN
    RAISE EXCEPTION 'Current live_money capability authorization is required.' USING ERRCODE = '42501';
  END IF;

  SELECT authority_event.decision, authority_event.expires_at
    INTO seller_decision, seller_expiry
  FROM performer_authority_events authority_event
  WHERE authority_event.performer_id = subject_performer_id
    AND authority_event.authority_kind = 'seller'
    AND authority_event.subject_type = 'seller'
    AND authority_event.subject_id = 'seller:' || subject_performer_id::text
  ORDER BY authority_event.event_sequence DESC
  LIMIT 1;
  IF seller_decision IS DISTINCT FROM 'granted'
    OR (seller_expiry IS NOT NULL AND seller_expiry <= evaluated_at) THEN
    RAISE EXCEPTION 'Current seller authority for this exact seller is required.' USING ERRCODE = '42501';
  END IF;

  SELECT authority_event.decision, authority_event.expires_at
    INTO payout_decision, payout_expiry
  FROM performer_authority_events authority_event
  WHERE authority_event.performer_id = subject_performer_id
    AND authority_event.authority_kind = 'payout_controller'
    AND authority_event.subject_type = 'payout_account'
    AND authority_event.subject_id = expected_destination_account_id
  ORDER BY authority_event.event_sequence DESC
  LIMIT 1;
  IF payout_decision IS DISTINCT FROM 'granted'
    OR (payout_expiry IS NOT NULL AND payout_expiry <= evaluated_at) THEN
    RAISE EXCEPTION 'Current payout-controller authority for this exact destination is required.' USING ERRCODE = '42501';
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE FUNCTION "sway_require_current_live_room_money_authority"(
  subject_gig_id uuid,
  expected_destination_account_id text,
  expected_environment text
) RETURNS void AS $$
DECLARE
  subject_performer_id uuid;
  subject_owner_actor_user_id uuid;
  performer_owner_user_id uuid;
  room_kind live_room_type;
  room_money_enabled boolean;
  room_destination_account_id text;
  room_money_environment text;
BEGIN
  SELECT
    room.performer_id,
    room.owner_actor_user_id,
    room.room_type,
    room.money_enabled,
    room.money_destination_account_id,
    room.money_environment
    INTO
      subject_performer_id,
      subject_owner_actor_user_id,
      room_kind,
      room_money_enabled,
      room_destination_account_id,
      room_money_environment
  FROM gig_sessions room
  WHERE room.id = subject_gig_id
  FOR UPDATE OF room;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live-room money requires an existing room.' USING ERRCODE = '42501';
  END IF;

  SELECT performer.owner_user_id INTO performer_owner_user_id
  FROM performers performer
  WHERE performer.id = subject_performer_id
  FOR UPDATE;

  IF NOT FOUND
    OR room_kind IS DISTINCT FROM 'music'
    OR room_money_enabled IS DISTINCT FROM true
    OR room_destination_account_id IS NULL
    OR room_destination_account_id IS DISTINCT FROM expected_destination_account_id
    OR room_money_environment IS DISTINCT FROM expected_environment
    OR subject_owner_actor_user_id IS NULL
    OR subject_owner_actor_user_id IS DISTINCT FROM performer_owner_user_id THEN
    RAISE EXCEPTION 'Live-room money mode or destination is not authorized.' USING ERRCODE = '42501';
  END IF;

  PERFORM sway_require_current_live_money_authority(
    subject_performer_id,
    expected_destination_account_id,
    expected_environment
  );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE FUNCTION "sway_serialize_live_money_capability_event"() RETURNS trigger AS $$
BEGIN
  IF NEW.capability = 'live_money' THEN
    PERFORM sway_live_money_authority_lock(NEW.performer_id);
    IF NEW.decision <> 'granted' AND EXISTS (
      SELECT 1
      FROM live_room_payment_operations operation
      WHERE operation.performer_id = NEW.performer_id
        AND operation.operation_type IN ('authorize', 'capture')
        AND operation.status = 'leased'
        AND (
          operation.lease_executor_generation IS NULL
          OR operation.lease_executor_generation < operation.minimum_executor_generation
        )
    ) THEN
      RAISE EXCEPTION 'A legacy positive-money executor lease must be reconciled before capability revocation.' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "performer_capability_grant_events_00_live_money_lock"
BEFORE INSERT ON "performer_capability_grant_events"
FOR EACH ROW EXECUTE FUNCTION "sway_serialize_live_money_capability_event"();--> statement-breakpoint
CREATE FUNCTION "sway_serialize_live_money_authority_event"() RETURNS trigger AS $$
BEGIN
  IF NEW.authority_kind IN ('seller', 'payout_controller') THEN
    PERFORM sway_live_money_authority_lock(NEW.performer_id);
    IF NEW.decision <> 'granted' AND EXISTS (
      SELECT 1
      FROM live_room_payment_operations operation
      WHERE operation.performer_id = NEW.performer_id
        AND operation.operation_type IN ('authorize', 'capture')
        AND operation.status = 'leased'
        AND (
          operation.lease_executor_generation IS NULL
          OR operation.lease_executor_generation < operation.minimum_executor_generation
        )
    ) THEN
      RAISE EXCEPTION 'A legacy positive-money executor lease must be reconciled before authority revocation.' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "performer_authority_events_00_live_money_lock"
BEFORE INSERT ON "performer_authority_events"
FOR EACH ROW EXECUTE FUNCTION "sway_serialize_live_money_authority_event"();--> statement-breakpoint
CREATE FUNCTION "sway_serialize_live_money_release_event"() RETURNS trigger AS $$
BEGIN
  PERFORM sway_live_money_release_lock(NEW.environment);
  IF NEW.decision = 'disabled' AND EXISTS (
    SELECT 1
    FROM live_room_payment_operations operation
    INNER JOIN gig_sessions room ON room.id = operation.gig_id
    WHERE room.money_environment = NEW.environment
      AND operation.operation_type IN ('authorize', 'capture')
      AND operation.status = 'leased'
      AND (
        operation.lease_executor_generation IS NULL
        OR operation.lease_executor_generation < operation.minimum_executor_generation
      )
  ) THEN
    RAISE EXCEPTION 'A legacy positive-money executor lease must be reconciled before release revocation.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "live_room_money_release_events_00_lock"
BEFORE INSERT ON "live_room_money_release_events"
FOR EACH ROW EXECUTE FUNCTION "sway_serialize_live_money_release_event"();--> statement-breakpoint
CREATE TRIGGER "live_room_money_release_events_append_only"
BEFORE UPDATE OR DELETE ON "live_room_money_release_events"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_wave1_immutable_mutation"();--> statement-breakpoint
CREATE FUNCTION "sway_enforce_positive_payment_executor_fence"() RETURNS trigger AS $$
DECLARE
  is_new_claim boolean := false;
  operation_environment text;
  release_decision text;
  release_expiry timestamptz;
  evaluated_at timestamptz;
BEGIN
  IF NEW.operation_type NOT IN ('authorize', 'capture') OR NEW.status <> 'leased' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    is_new_claim := true;
  ELSE
    is_new_claim := OLD.status IS DISTINCT FROM 'leased'
      OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
      OR NEW.lease_executor_generation IS DISTINCT FROM OLD.lease_executor_generation;
  END IF;
  IF NOT is_new_claim THEN
    RETURN NEW;
  END IF;
  IF NEW.lease_executor_generation IS NULL
    OR NEW.lease_executor_generation < NEW.minimum_executor_generation THEN
    RAISE EXCEPTION 'Positive payment operation requires the current executor generation.' USING ERRCODE = '42501';
  END IF;

  SELECT room.money_environment INTO operation_environment
  FROM gig_sessions room
  WHERE room.id = NEW.gig_id;
  IF operation_environment NOT IN ('test', 'live') THEN
    RAISE EXCEPTION 'Positive payment operation has no exact money environment.' USING ERRCODE = '42501';
  END IF;

  PERFORM sway_live_money_release_admission_lock(operation_environment);
  evaluated_at := clock_timestamp();
  SELECT release_event.decision, release_event.expires_at
    INTO release_decision, release_expiry
  FROM live_room_money_release_events release_event
  WHERE release_event.environment = operation_environment
  ORDER BY release_event.event_sequence DESC
  LIMIT 1;
  IF release_decision IS DISTINCT FROM 'enabled'
    OR (release_expiry IS NOT NULL AND release_expiry <= evaluated_at) THEN
    RAISE EXCEPTION 'Positive payment operation claim requires a current durable release.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "live_room_payment_operations_05_positive_executor_fence"
BEFORE INSERT OR UPDATE OF "status", "lease_owner", "lease_executor_generation"
ON "live_room_payment_operations"
FOR EACH ROW EXECUTE FUNCTION "sway_enforce_positive_payment_executor_fence"();--> statement-breakpoint
CREATE FUNCTION "sway_preserve_live_room_payment_financial_identity"() RETURNS trigger AS $$
BEGIN
  IF OLD.legacy_unlinked IS DISTINCT FROM true AND (
    NEW.legacy_unlinked IS DISTINCT FROM OLD.legacy_unlinked
    OR NEW.gig_id IS DISTINCT FROM OLD.gig_id
    OR NEW.performer_id IS DISTINCT FROM OLD.performer_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.request_boost_id IS DISTINCT FROM OLD.request_boost_id
    OR NEW.action_type IS DISTINCT FROM OLD.action_type
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.destination_account_id IS DISTINCT FROM OLD.destination_account_id
    OR NEW.processor IS DISTINCT FROM OLD.processor
    OR NEW.amount_subtotal IS DISTINCT FROM OLD.amount_subtotal
    OR NEW.platform_fee IS DISTINCT FROM OLD.platform_fee
    OR NEW.amount_total IS DISTINCT FROM OLD.amount_total
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.attribution_source IS DISTINCT FROM OLD.attribution_source
    OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id
    OR NEW.commission_bps_applied IS DISTINCT FROM OLD.commission_bps_applied
    OR NEW.capture_mode IS DISTINCT FROM OLD.capture_mode
  ) THEN
    RAISE EXCEPTION 'Durable payment financial identity is immutable.' USING ERRCODE = '23514', CONSTRAINT = 'payments_financial_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "payments_05_financial_identity_immutable"
BEFORE UPDATE ON "payments"
FOR EACH ROW EXECUTE FUNCTION "sway_preserve_live_room_payment_financial_identity"();--> statement-breakpoint
CREATE FUNCTION "sway_preserve_live_room_payment_operation_identity"() RETURNS trigger AS $$
BEGIN
  IF NEW.payment_id IS DISTINCT FROM OLD.payment_id
    OR NEW.gig_id IS DISTINCT FROM OLD.gig_id
    OR NEW.performer_id IS DISTINCT FROM OLD.performer_id
    OR NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.request_boost_id IS DISTINCT FROM OLD.request_boost_id
    OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
    OR NEW.processor IS DISTINCT FROM OLD.processor
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.destination_account_id IS DISTINCT FROM OLD.destination_account_id
    OR NEW.request_payload IS DISTINCT FROM OLD.request_payload
    OR NEW.minimum_executor_generation IS DISTINCT FROM OLD.minimum_executor_generation THEN
    RAISE EXCEPTION 'Durable payment operation identity is immutable.' USING ERRCODE = '23514', CONSTRAINT = 'live_room_payment_operations_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "live_room_payment_operations_00_identity_immutable"
BEFORE UPDATE ON "live_room_payment_operations"
FOR EACH ROW EXECUTE FUNCTION "sway_preserve_live_room_payment_operation_identity"();--> statement-breakpoint
CREATE FUNCTION "sway_event_room_link_lock"(subject_event_id uuid) RETURNS void AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('sway:event-room:' || subject_event_id::text, 0));
$$ LANGUAGE sql VOLATILE STRICT;--> statement-breakpoint
CREATE FUNCTION "sway_try_event_room_link_lock"(subject_event_id uuid) RETURNS boolean AS $$
  SELECT pg_try_advisory_xact_lock(hashtextextended('sway:event-room:' || subject_event_id::text, 0));
$$ LANGUAGE sql VOLATILE STRICT;--> statement-breakpoint
CREATE FUNCTION "sway_event_room_link_is_eligible"(
  event_status performer_event_status,
  event_ticketing_mode performer_event_ticketing_mode,
  event_attendance_mode performer_event_attendance_mode,
  event_starts_at timestamptz,
  event_ends_at timestamptz,
  event_location_is_tba boolean,
  event_location_name text,
  event_location_address text,
  event_city text,
  evaluated_at timestamptz
) RETURNS boolean AS $$
  SELECT
    event_status = 'published'
    AND event_ticketing_mode = 'external'
    AND event_attendance_mode IN ('walk_in', 'external_rsvp', 'external_ticket')
    AND evaluated_at >= event_starts_at - interval '24 hours'
    AND evaluated_at < coalesce(event_ends_at, event_starts_at + interval '4 hours')
    AND (
      event_attendance_mode <> 'walk_in'
      OR (
        event_location_is_tba = false
        AND nullif(trim(event_location_name), '') IS NOT NULL
        AND (
          nullif(trim(event_location_address), '') IS NOT NULL
          OR nullif(trim(event_city), '') IS NOT NULL
        )
      )
    );
$$ LANGUAGE sql IMMUTABLE;--> statement-breakpoint
CREATE FUNCTION "sway_sync_live_room_money_projection"() RETURNS trigger AS $$
DECLARE
  legacy_money_requested boolean;
  legacy_projection_changed boolean;
  relational_money_changed boolean;
  projected_environment text;
  projected_settlement_mode text;
  connected_account_id text;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.status IN ('active', 'closeout_pending')
    AND NEW.room_type IS DISTINCT FROM OLD.room_type THEN
    RAISE EXCEPTION 'Room type is immutable after a room becomes active.'
      USING ERRCODE = '23514', CONSTRAINT = 'gig_sessions_active_room_type_immutable';
  END IF;

  legacy_money_requested := coalesce(NEW.runtime_session_state->>'paymentsEnabled', 'false') = 'true'
    OR coalesce(NEW.runtime_session_state->>'tipsEnabled', 'false') = 'true';
  IF NEW.room_type <> 'music' AND legacy_money_requested THEN
    RAISE EXCEPTION 'Nonmusic rooms cannot project paid requests or tips.'
      USING ERRCODE = '23514', CONSTRAINT = 'gig_sessions_nonmusic_money_projection';
  END IF;

  IF TG_OP = 'INSERT' THEN
    legacy_projection_changed := true;
    relational_money_changed := NEW.money_enabled
      OR NEW.money_destination_account_id IS NOT NULL
      OR NEW.money_environment IS NOT NULL;
  ELSE
    legacy_projection_changed :=
      coalesce(NEW.runtime_session_state->>'paymentsEnabled', 'false')
        IS DISTINCT FROM coalesce(OLD.runtime_session_state->>'paymentsEnabled', 'false')
      OR coalesce(NEW.runtime_session_state->>'tipsEnabled', 'false')
        IS DISTINCT FROM coalesce(OLD.runtime_session_state->>'tipsEnabled', 'false');
    relational_money_changed := NEW.money_enabled IS DISTINCT FROM OLD.money_enabled
      OR NEW.money_destination_account_id IS DISTINCT FROM OLD.money_destination_account_id
      OR NEW.money_environment IS DISTINCT FROM OLD.money_environment;
  END IF;

  IF legacy_projection_changed AND NOT relational_money_changed THEN
    IF legacy_money_requested THEN
      projected_environment := NEW.runtime_session_state->>'paymentEnvironment';
      projected_settlement_mode := NEW.runtime_session_state->>'settlementMode';
      IF projected_environment NOT IN ('test', 'live') THEN
        RAISE EXCEPTION 'Legacy paid room writes require an exact test or live environment.' USING ERRCODE = '42501';
      END IF;
      SELECT performer.stripe_connected_account_id INTO connected_account_id
      FROM performers performer
      WHERE performer.id = NEW.performer_id;
      NEW.money_destination_account_id := CASE
        WHEN projected_settlement_mode = 'platform_test_balance' AND projected_environment = 'test'
          THEN 'sway_test_platform_balance'
        WHEN projected_settlement_mode = 'connected_account'
          THEN nullif(trim(connected_account_id), '')
        ELSE NULL
      END;
      IF NEW.money_destination_account_id IS NULL THEN
        RAISE EXCEPTION 'Legacy paid room write has no exact durable payout destination.' USING ERRCODE = '42501';
      END IF;
      NEW.money_enabled := true;
      NEW.money_environment := projected_environment;
    ELSE
      NEW.money_enabled := false;
      NEW.money_destination_account_id := NULL;
      NEW.money_environment := NULL;
    END IF;
  END IF;

  IF NEW.money_enabled THEN
    NEW.runtime_session_state := coalesce(NEW.runtime_session_state, '{}'::jsonb)
      || jsonb_build_object(
        'paymentsEnabled', true,
        'tipsEnabled', true,
        'settlementMode', CASE
          WHEN NEW.money_destination_account_id = 'sway_test_platform_balance' THEN 'platform_test_balance'
          ELSE 'connected_account'
        END,
        'paymentEnvironment', NEW.money_environment
      );
  ELSE
    NEW.money_destination_account_id := NULL;
    NEW.money_environment := NULL;
    NEW.runtime_session_state := coalesce(NEW.runtime_session_state, '{}'::jsonb)
      || jsonb_build_object(
        'paymentsEnabled', false,
        'tipsEnabled', false,
        'settlementMode', 'unavailable',
        'paymentEnvironment', 'unavailable'
      );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "gig_sessions_00_money_projection_sync"
BEFORE INSERT OR UPDATE ON "gig_sessions"
FOR EACH ROW EXECUTE FUNCTION "sway_sync_live_room_money_projection"();--> statement-breakpoint
CREATE FUNCTION "sway_enforce_live_room_capabilities"() RETURNS trigger AS $$
DECLARE
  requires_live_capability boolean;
  linking_event boolean;
  enabling_money boolean;
  lifecycle_lock_acquired boolean;
  linked_event performer_events%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    requires_live_capability := NEW.status IN ('active', 'closeout_pending');
    linking_event := NEW.linked_event_id IS NOT NULL AND requires_live_capability;
    enabling_money := NEW.money_enabled;
  ELSE
    -- A revoked host cannot keep mutating a room that is still active. Allow
    -- only the risk-reducing active -> closeout_pending transition and the
    -- remaining closeout path to proceed without fresh creation authority.
    requires_live_capability := NEW.status = 'active'
      OR (
        NEW.status = 'closeout_pending'
        AND OLD.status NOT IN ('active', 'closeout_pending')
      );
    linking_event := NEW.linked_event_id IS NOT NULL
      AND NEW.status IN ('active', 'closeout_pending')
      AND (
        NEW.linked_event_id IS DISTINCT FROM OLD.linked_event_id
        OR OLD.status NOT IN ('active', 'closeout_pending')
      );
    enabling_money := NEW.money_enabled
      AND (
        OLD.money_enabled IS DISTINCT FROM true
        OR NEW.money_destination_account_id IS DISTINCT FROM OLD.money_destination_account_id
        OR NEW.money_environment IS DISTINCT FROM OLD.money_environment
      );
  END IF;

  IF NEW.linked_event_id IS NOT NULL AND NEW.status IN ('active', 'closeout_pending') THEN
    IF TG_OP = 'UPDATE'
      AND NEW.linked_event_id IS NOT DISTINCT FROM OLD.linked_event_id THEN
      -- This row is already locked before a BEFORE ROW trigger runs. Never
      -- wait row -> advisory while an event lifecycle transaction owns the
      -- advisory lock and waits for this row; fail fast and let the caller
      -- retry after that bounded lifecycle mutation commits.
      lifecycle_lock_acquired := sway_try_event_room_link_lock(NEW.linked_event_id);
      IF lifecycle_lock_acquired IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Event-room lifecycle is busy; retry this room mutation.'
          USING ERRCODE = '40001', CONSTRAINT = 'gig_sessions_event_lifecycle_retry';
      END IF;
    ELSE
      PERFORM sway_event_room_link_lock(NEW.linked_event_id);
    END IF;
  END IF;
  IF enabling_money THEN
    PERFORM 1
    FROM performers performer
    WHERE performer.id = NEW.performer_id
      AND performer.owner_user_id = NEW.owner_actor_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Paid room owner must match the durable performer owner.' USING ERRCODE = '42501';
    END IF;
    PERFORM sway_require_current_live_money_authority(
      NEW.performer_id,
      NEW.money_destination_account_id,
      NEW.money_environment
    );
  END IF;
  IF requires_live_capability THEN
    PERFORM sway_require_current_performer_capability(NEW.performer_id, 'live_rooms');
  END IF;
  IF linking_event THEN
    PERFORM sway_require_current_event_organizer_authority(NEW.performer_id, NEW.linked_event_id);
  END IF;
  IF NEW.linked_event_id IS NOT NULL AND NEW.status IN ('active', 'closeout_pending') THEN
    SELECT event.* INTO linked_event
    FROM performer_events event
    WHERE event.id = NEW.linked_event_id
      AND event.performer_id = NEW.performer_id
    FOR SHARE;
    IF NOT FOUND OR NOT sway_event_room_link_is_eligible(
      linked_event.status,
      linked_event.ticketing_mode,
      linked_event.attendance_mode,
      linked_event.starts_at,
      linked_event.ends_at,
      linked_event.location_is_tba,
      linked_event.location_name,
      linked_event.location_address,
      linked_event.city,
      clock_timestamp()
    ) THEN
      IF TG_OP = 'UPDATE'
        AND NEW.linked_event_id IS NOT DISTINCT FROM OLD.linked_event_id THEN
        INSERT INTO audit_events (
          actor_type, actor_id, entity_type, entity_id, event_type,
          previous_status, next_status, metadata
        ) VALUES (
          'system', NULL, 'gig_session', NEW.id, 'gig_session.linked_event_detached',
          NEW.status::text, NEW.status::text,
          jsonb_build_object(
            'eventId', NEW.linked_event_id,
            'reason', 'event_link_no_longer_eligible',
            'source', 'gig_sessions_capability_guard'
          )
        );
        NEW.linked_event_id := NULL;
        NEW.runtime_session_state := coalesce(NEW.runtime_session_state, '{}'::jsonb)
          || jsonb_build_object('linkedEventId', NULL, 'linkedEvent', NULL);
      ELSE
        RAISE EXCEPTION 'Linked event is not eligible for an active Sway room.'
          USING ERRCODE = '23514', CONSTRAINT = 'gig_sessions_linked_event_eligible';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "gig_sessions_capability_guard"
BEFORE INSERT OR UPDATE
ON "gig_sessions"
FOR EACH ROW EXECUTE FUNCTION "sway_enforce_live_room_capabilities"();--> statement-breakpoint
CREATE FUNCTION "sway_guard_active_room_event_mutation"() RETURNS trigger AS $$
DECLARE
  material_change boolean;
BEGIN
  material_change := NEW.status IS DISTINCT FROM OLD.status
    OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
    OR NEW.location_name IS DISTINCT FROM OLD.location_name
    OR NEW.location_address IS DISTINCT FROM OLD.location_address
    OR NEW.city IS DISTINCT FROM OLD.city
    OR NEW.location_is_tba IS DISTINCT FROM OLD.location_is_tba
    OR NEW.ticketing_mode IS DISTINCT FROM OLD.ticketing_mode
    OR NEW.attendance_mode IS DISTINCT FROM OLD.attendance_mode
    OR NEW.external_ticket_url IS DISTINCT FROM OLD.external_ticket_url
    OR NEW.external_ticket_label IS DISTINCT FROM OLD.external_ticket_label;
  IF NOT material_change THEN
    RETURN NEW;
  END IF;

  -- PostgreSQL already owns this event row before a BEFORE ROW trigger runs.
  -- Do not acquire the event advisory lock here: service writers use
  -- advisory -> event row, so row -> advisory would recreate a deadlock.
  -- Room-link writers take the event row FOR SHARE after their advisory lock;
  -- that row lock alone serializes this direct mutation with link creation.
  IF EXISTS (
    SELECT 1
    FROM gig_sessions room
    WHERE room.linked_event_id = OLD.id
      AND room.status IN ('active', 'closeout_pending')
  ) THEN
    RAISE EXCEPTION 'Detach the active Sway room before changing linked event lifecycle fields.'
      USING ERRCODE = '23514', CONSTRAINT = 'performer_events_active_room_link_guard';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "performer_events_50_active_room_link_guard"
BEFORE UPDATE ON "performer_events"
FOR EACH ROW EXECUTE FUNCTION "sway_guard_active_room_event_mutation"();--> statement-breakpoint
CREATE FUNCTION "sway_enforce_performer_event_capabilities"() RETURNS trigger AS $$
DECLARE
  cancellation_transition boolean;
BEGIN
  cancellation_transition := TG_OP = 'UPDATE'
    AND NEW.status = 'cancelled'
    AND OLD.status IS DISTINCT FROM 'cancelled';

  IF TG_OP = 'INSERT' OR NOT cancellation_transition THEN
    PERFORM sway_require_current_performer_capability(NEW.performer_id, 'event_publication');
    IF NEW.external_ticket_url IS NOT NULL THEN
      PERFORM sway_require_current_performer_capability(NEW.performer_id, 'external_ticket_links');
    END IF;
    PERFORM sway_require_current_event_organizer_authority(NEW.performer_id, NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "performer_events_90_enforce_capabilities"
AFTER INSERT OR UPDATE
ON "performer_events"
FOR EACH ROW EXECUTE FUNCTION "sway_enforce_performer_event_capabilities"();
