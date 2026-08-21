CREATE TYPE "public"."acquisition_source_class" AS ENUM('organic_unpaid', 'paid', 'direct', 'referral', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."attribution_evidence_strength" AS ENUM('direct_server_observed', 'client_correlated_unverified', 'offline_self_reported', 'unknown_unavailable');--> statement-breakpoint
CREATE TYPE "public"."growth_milestone_kind" AS ENUM('qualified_signup', 'first_value');--> statement-breakpoint
CREATE TYPE "public"."growth_value_kind" AS ENUM('profile_published', 'event_published', 'inquiry_received', 'live_room_completed', 'release_ready');--> statement-breakpoint
CREATE TYPE "public"."performer_authority_kind" AS ENUM('seller', 'event_organizer', 'venue_representative', 'ticket_inventory', 'catalog_controller', 'payout_controller', 'brand_representative');--> statement-breakpoint
CREATE TYPE "public"."performer_capability_decision" AS ENUM('granted', 'revoked', 'expired', 'denied');--> statement-breakpoint
CREATE TYPE "public"."performer_capability" AS ENUM('profile_publication', 'public_discovery', 'non_money_inquiries', 'live_rooms', 'live_money', 'event_publication', 'external_ticket_links', 'native_ticket_sales', 'private_collaboration', 'release_preparation', 'audio_publication', 'audio_sales', 'dsp_delivery', 'royalty_processing', 'partnership_inquiries', 'service_inquiries');--> statement-breakpoint
CREATE TYPE "public"."performer_earning_mode" AS ENUM('live_tips', 'audience_requests', 'bookings', 'partnerships', 'services', 'releases', 'events', 'ticket_sales', 'audio_sales', 'sponsorships', 'merchandise');--> statement-breakpoint
CREATE TYPE "public"."performer_intent_type" AS ENUM('earning_mode', 'desired_capability');--> statement-breakpoint
CREATE TYPE "public"."professional_identity_kind" AS ENUM('comedian', 'singer', 'songwriter', 'dj', 'musician', 'band', 'producer', 'host', 'emcee', 'bartender', 'dancer', 'actor', 'speaker', 'podcaster', 'magician', 'event_professional', 'vendor', 'service_professional', 'creator', 'other');--> statement-breakpoint
CREATE TABLE "account_discovery_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"journey_entity_id" uuid NOT NULL,
	"source_channel" text NOT NULL,
	"source_class" "acquisition_source_class" NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"landing_path" text NOT NULL,
	"entity_kind" text,
	"entity_key" text,
	"offline_source" text,
	"first_touch_at" timestamp with time zone NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_strength" "attribution_evidence_strength" NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_discovery_attributions_source_channel_valid" CHECK ("account_discovery_attributions"."source_channel" ~ '^[a-z0-9][a-z0-9_.:-]{0,79}$'),
	CONSTRAINT "account_discovery_attributions_landing_path_valid" CHECK (length("account_discovery_attributions"."landing_path") between 1 and 300 and "account_discovery_attributions"."landing_path" like '/%' and "account_discovery_attributions"."landing_path" !~ '[?#]'),
	CONSTRAINT "account_discovery_attributions_entity_pair_valid" CHECK ((
    ("account_discovery_attributions"."entity_kind" is null and "account_discovery_attributions"."entity_key" is null)
    or
    ("account_discovery_attributions"."entity_kind" in ('performer', 'event', 'release', 'live_room') and "account_discovery_attributions"."entity_key" ~ '^[a-z0-9][a-z0-9_.:-]{0,127}$')
  )),
	CONSTRAINT "account_discovery_attributions_utm_values_valid" CHECK ((
    ("account_discovery_attributions"."utm_source" is null or (length("account_discovery_attributions"."utm_source") between 1 and 100 and "account_discovery_attributions"."utm_source" !~ '[?&#=]'))
    and ("account_discovery_attributions"."utm_medium" is null or (length("account_discovery_attributions"."utm_medium") between 1 and 100 and "account_discovery_attributions"."utm_medium" !~ '[?&#=]'))
    and ("account_discovery_attributions"."utm_campaign" is null or (length("account_discovery_attributions"."utm_campaign") between 1 and 160 and "account_discovery_attributions"."utm_campaign" !~ '[?&#=]'))
  )),
	CONSTRAINT "account_discovery_attributions_offline_source_valid" CHECK ("account_discovery_attributions"."offline_source" is null or length(trim("account_discovery_attributions"."offline_source")) between 1 and 80),
	CONSTRAINT "account_discovery_attributions_chronology_valid" CHECK ("account_discovery_attributions"."first_touch_at" <= "account_discovery_attributions"."linked_at"),
	CONSTRAINT "account_discovery_attributions_idempotency_hash_valid" CHECK ("account_discovery_attributions"."idempotency_key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "growth_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_sequence" bigserial NOT NULL,
	"user_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"attribution_id" uuid NOT NULL,
	"milestone_kind" "growth_milestone_kind" NOT NULL,
	"value_kind" "growth_value_kind",
	"evidence_event_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"environment" text NOT NULL,
	"qualification_snapshot" jsonb NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "growth_milestones_shape_valid" CHECK ((
    ("growth_milestones"."milestone_kind" = 'qualified_signup' and "growth_milestones"."value_kind" is null)
    or
    ("growth_milestones"."milestone_kind" = 'first_value' and "growth_milestones"."value_kind" is not null)
  )),
	CONSTRAINT "growth_milestones_environment_allowed" CHECK ("growth_milestones"."environment" in ('production', 'test', 'development')),
	CONSTRAINT "growth_milestones_snapshot_required" CHECK (jsonb_typeof("growth_milestones"."qualification_snapshot") = 'object' and "growth_milestones"."qualification_snapshot" <> '{}'::jsonb),
	CONSTRAINT "growth_milestones_chronology_valid" CHECK ("growth_milestones"."occurred_at" <= "growth_milestones"."created_at"),
	CONSTRAINT "growth_milestones_idempotency_hash_valid" CHECK ("growth_milestones"."idempotency_key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "performer_authority_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_sequence" bigserial NOT NULL,
	"performer_id" uuid NOT NULL,
	"authority_kind" "performer_authority_kind" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"decision" "performer_capability_decision" NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" uuid,
	"reason" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"idempotency_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_authority_events_subject_type_allowed" CHECK ("performer_authority_events"."subject_type" in ('platform', 'seller', 'event', 'venue', 'ticket_offer', 'catalog', 'payout_account', 'brand')),
	CONSTRAINT "performer_authority_events_subject_id_valid" CHECK ("performer_authority_events"."subject_id" ~ '^[a-z0-9][a-z0-9_.:-]{0,254}$'),
	CONSTRAINT "performer_authority_events_actor_shape_valid" CHECK ((
    ("performer_authority_events"."actor_type" = 'admin' and "performer_authority_events"."actor_user_id" is not null)
    or
    ("performer_authority_events"."actor_type" = 'system' and "performer_authority_events"."actor_user_id" is null)
  )),
	CONSTRAINT "performer_authority_events_reason_valid" CHECK (length(trim("performer_authority_events"."reason")) between 1 and 500),
	CONSTRAINT "performer_authority_events_evidence_required" CHECK (jsonb_typeof("performer_authority_events"."evidence") = 'object' and "performer_authority_events"."evidence" <> '{}'::jsonb),
	CONSTRAINT "performer_authority_events_expiry_valid" CHECK ((
    ("performer_authority_events"."decision" = 'granted' and ("performer_authority_events"."expires_at" is null or "performer_authority_events"."expires_at" > "performer_authority_events"."created_at"))
    or
    ("performer_authority_events"."decision" <> 'granted' and "performer_authority_events"."expires_at" is null)
  )),
	CONSTRAINT "performer_authority_events_idempotency_hash_valid" CHECK ("performer_authority_events"."idempotency_key_hash" ~ '^[0-9a-f]{64}$')
);
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
CREATE TABLE "performer_identity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_sequence" bigserial NOT NULL,
	"performer_id" uuid NOT NULL,
	"identity_role" text NOT NULL,
	"identity_kind" "professional_identity_kind" NOT NULL,
	"custom_label" text,
	"event_type" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_identity_events_role_allowed" CHECK ("performer_identity_events"."identity_role" in ('primary', 'secondary')),
	CONSTRAINT "performer_identity_events_type_allowed" CHECK ("performer_identity_events"."event_type" in ('selected', 'withdrawn')),
	CONSTRAINT "performer_identity_events_custom_label_valid" CHECK ((
    ("performer_identity_events"."identity_kind" = 'other' and nullif(trim("performer_identity_events"."custom_label"), '') is not null and length(trim("performer_identity_events"."custom_label")) <= 80)
    or
    ("performer_identity_events"."identity_kind" <> 'other' and ("performer_identity_events"."custom_label" is null or (length(trim("performer_identity_events"."custom_label")) between 1 and 80)))
  )),
	CONSTRAINT "performer_identity_events_idempotency_hash_valid" CHECK ("performer_identity_events"."idempotency_key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "performer_intent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_sequence" bigserial NOT NULL,
	"performer_id" uuid NOT NULL,
	"intent_type" "performer_intent_type" NOT NULL,
	"earning_mode" "performer_earning_mode",
	"desired_capability" "performer_capability",
	"event_type" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_intent_events_type_allowed" CHECK ("performer_intent_events"."event_type" in ('selected', 'withdrawn')),
	CONSTRAINT "performer_intent_events_payload_matches_type" CHECK ((
    ("performer_intent_events"."intent_type" = 'earning_mode' and "performer_intent_events"."earning_mode" is not null and "performer_intent_events"."desired_capability" is null)
    or
    ("performer_intent_events"."intent_type" = 'desired_capability' and "performer_intent_events"."desired_capability" is not null and "performer_intent_events"."earning_mode" is null)
  )),
	CONSTRAINT "performer_intent_events_idempotency_hash_valid" CHECK ("performer_intent_events"."idempotency_key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "growth_milestones" ADD CONSTRAINT "growth_milestones_attribution_id_account_discovery_attributions_id_fk" FOREIGN KEY ("attribution_id") REFERENCES "public"."account_discovery_attributions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_authority_events" ADD CONSTRAINT "performer_authority_events_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_capability_grant_events" ADD CONSTRAINT "performer_capability_grant_events_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_identity_events" ADD CONSTRAINT "performer_identity_events_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_intent_events" ADD CONSTRAINT "performer_intent_events_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_discovery_attributions_user_idx" ON "account_discovery_attributions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_discovery_attributions_journey_idx" ON "account_discovery_attributions" USING btree ("journey_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_discovery_attributions_source_event_idx" ON "account_discovery_attributions" USING btree ("source_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_discovery_attributions_idempotency_idx" ON "account_discovery_attributions" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_milestones_sequence_idx" ON "growth_milestones" USING btree ("event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_milestones_user_kind_environment_idx" ON "growth_milestones" USING btree ("user_id","milestone_kind","environment");--> statement-breakpoint
CREATE UNIQUE INDEX "growth_milestones_idempotency_idx" ON "growth_milestones" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "growth_milestones_performer_occurred_idx" ON "growth_milestones" USING btree ("performer_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_authority_events_sequence_idx" ON "performer_authority_events" USING btree ("event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_authority_events_idempotency_idx" ON "performer_authority_events" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "performer_authority_events_current_idx" ON "performer_authority_events" USING btree ("performer_id","authority_kind","subject_type","subject_id","event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_capability_grant_events_sequence_idx" ON "performer_capability_grant_events" USING btree ("event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_capability_grant_events_idempotency_idx" ON "performer_capability_grant_events" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "performer_capability_grant_events_current_idx" ON "performer_capability_grant_events" USING btree ("performer_id","capability","event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_identity_events_sequence_idx" ON "performer_identity_events" USING btree ("event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_identity_events_idempotency_idx" ON "performer_identity_events" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "performer_identity_events_current_idx" ON "performer_identity_events" USING btree ("performer_id","identity_role","event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_intent_events_sequence_idx" ON "performer_intent_events" USING btree ("event_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_intent_events_idempotency_idx" ON "performer_intent_events" USING btree ("idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "performer_intent_events_current_idx" ON "performer_intent_events" USING btree ("performer_id","intent_type","event_sequence");
--> statement-breakpoint
CREATE FUNCTION "sway_reject_wave1_immutable_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Sway Wave 1 identity, intent, grant, authority, attribution, and growth records are append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_performer_identity_event"() RETURNS trigger AS $$
DECLARE
  owner_user uuid;
  latest_event text;
  latest_kind text;
  latest_label text;
  normalized_label text := coalesce(lower(trim(NEW.custom_label)), '');
BEGIN
  SELECT owner_user_id INTO owner_user
  FROM performers
  WHERE id = NEW.performer_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Professional identity requires an existing performer.';
  END IF;
  IF NEW.actor_user_id <> owner_user THEN
    RAISE EXCEPTION 'Only the performer owner may declare professional identity.';
  END IF;
  NEW.event_sequence := nextval(pg_get_serial_sequence('performer_identity_events', 'event_sequence'));

  IF NEW.identity_role = 'primary' THEN
    SELECT event_type, identity_kind::text, coalesce(lower(trim(custom_label)), '')
      INTO latest_event, latest_kind, latest_label
    FROM performer_identity_events
    WHERE performer_id = NEW.performer_id
      AND identity_role = 'primary'
    ORDER BY event_sequence DESC
    LIMIT 1;
  ELSE
    SELECT event_type, identity_kind::text, coalesce(lower(trim(custom_label)), '')
      INTO latest_event, latest_kind, latest_label
    FROM performer_identity_events
    WHERE performer_id = NEW.performer_id
      AND identity_role = 'secondary'
      AND identity_kind = NEW.identity_kind
      AND coalesce(lower(trim(custom_label)), '') = normalized_label
    ORDER BY event_sequence DESC
    LIMIT 1;
  END IF;

  IF NEW.event_type = 'selected' THEN
    IF latest_event = 'selected'
      AND (NEW.identity_role = 'secondary' OR (latest_kind = NEW.identity_kind::text AND latest_label = normalized_label)) THEN
      RAISE EXCEPTION 'Professional identity is already selected.';
    END IF;
  ELSIF latest_event IS DISTINCT FROM 'selected'
    OR latest_kind IS DISTINCT FROM NEW.identity_kind::text
    OR latest_label IS DISTINCT FROM normalized_label THEN
    RAISE EXCEPTION 'Only the currently selected professional identity may be withdrawn.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_performer_intent_event"() RETURNS trigger AS $$
DECLARE
  owner_user uuid;
  latest_event text;
BEGIN
  SELECT owner_user_id INTO owner_user
  FROM performers
  WHERE id = NEW.performer_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Professional intent requires an existing performer.';
  END IF;
  IF NEW.actor_user_id <> owner_user THEN
    RAISE EXCEPTION 'Only the performer owner may declare earning modes or desired capabilities.';
  END IF;
  NEW.event_sequence := nextval(pg_get_serial_sequence('performer_intent_events', 'event_sequence'));

  SELECT event_type INTO latest_event
  FROM performer_intent_events
  WHERE performer_id = NEW.performer_id
    AND intent_type = NEW.intent_type
    AND earning_mode IS NOT DISTINCT FROM NEW.earning_mode
    AND desired_capability IS NOT DISTINCT FROM NEW.desired_capability
  ORDER BY event_sequence DESC
  LIMIT 1;

  IF NEW.event_type = 'selected' AND latest_event = 'selected' THEN
    RAISE EXCEPTION 'Professional intent is already selected.';
  END IF;
  IF NEW.event_type = 'withdrawn' AND latest_event IS DISTINCT FROM 'selected' THEN
    RAISE EXCEPTION 'Only a selected professional intent may be withdrawn.';
  END IF;

  RETURN NEW;
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
CREATE FUNCTION "sway_validate_performer_authority_decision"() RETURNS trigger AS $$
DECLARE
  latest_decision performer_capability_decision;
  latest_expiry timestamptz;
  latest_is_active boolean;
BEGIN
  PERFORM 1 FROM performers WHERE id = NEW.performer_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Authority decisions require an existing performer.';
  END IF;
  PERFORM sway_require_wave1_decision_actor(NEW.actor_type, NEW.actor_user_id);
  NEW.event_sequence := nextval(pg_get_serial_sequence('performer_authority_events', 'event_sequence'));

  IF NOT (
    (NEW.authority_kind = 'seller' AND NEW.subject_type = 'seller')
    OR (NEW.authority_kind = 'event_organizer' AND NEW.subject_type = 'event')
    OR (NEW.authority_kind = 'venue_representative' AND NEW.subject_type = 'venue')
    OR (NEW.authority_kind = 'ticket_inventory' AND NEW.subject_type = 'ticket_offer')
    OR (NEW.authority_kind = 'catalog_controller' AND NEW.subject_type = 'catalog')
    OR (NEW.authority_kind = 'payout_controller' AND NEW.subject_type = 'payout_account')
    OR (NEW.authority_kind = 'brand_representative' AND NEW.subject_type = 'brand')
  ) THEN
    RAISE EXCEPTION 'Authority kind must match its exact subject type.';
  END IF;
  IF coalesce(jsonb_typeof(NEW.evidence->'reference'), '') <> 'string'
    OR nullif(trim(NEW.evidence->>'reference'), '') IS NULL THEN
    RAISE EXCEPTION 'Authority decisions require a non-empty durable evidence reference.';
  END IF;
  IF NEW.subject_type IN ('event', 'ticket_offer')
    AND NEW.subject_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Internal authority subjects require a UUID identifier.';
  ELSIF NEW.subject_type = 'event' THEN
    PERFORM 1 FROM performer_events
    WHERE id = NEW.subject_id::uuid AND performer_id = NEW.performer_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Event authority requires an existing event owned by the performer.';
    END IF;
  ELSIF NEW.subject_type = 'ticket_offer' THEN
    PERFORM 1 FROM event_ticket_offers
    WHERE id = NEW.subject_id::uuid AND performer_id = NEW.performer_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ticket inventory authority requires an existing offer owned by the performer.';
    END IF;
  END IF;

  SELECT decision, expires_at INTO latest_decision, latest_expiry
  FROM performer_authority_events
  WHERE performer_id = NEW.performer_id
    AND authority_kind = NEW.authority_kind
    AND subject_type = NEW.subject_type
    AND subject_id = NEW.subject_id
  ORDER BY event_sequence DESC
  LIMIT 1;

  latest_is_active := latest_decision = 'granted'
    AND (latest_expiry IS NULL OR latest_expiry > NEW.created_at);

  IF NEW.decision = 'granted' AND latest_is_active THEN
    RAISE EXCEPTION 'Active subject authority must be revoked or expired before another grant.';
  ELSIF NEW.decision = 'revoked' AND NOT coalesce(latest_is_active, false) THEN
    RAISE EXCEPTION 'Only the latest active subject authority may be revoked or expired.';
  ELSIF NEW.decision = 'expired' AND (
    latest_decision IS DISTINCT FROM 'granted'
    OR latest_expiry IS NULL
    OR latest_expiry > NEW.created_at
  ) THEN
    RAISE EXCEPTION 'Subject authority cannot expire before its recorded expiry.';
  ELSIF NEW.decision = 'denied' AND latest_is_active THEN
    RAISE EXCEPTION 'Active subject authority must be revoked, not overwritten by a denial.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_account_discovery_attribution"() RETURNS trigger AS $$
DECLARE
  source_row audit_events%ROWTYPE;
  source_time timestamptz;
  source_channel text;
  source_class text;
  source_path text;
  source_entity_kind text;
  source_entity_key text;
  source_strength text;
  source_utm_source text;
  source_utm_medium text;
  source_utm_campaign text;
  source_offline_source text;
BEGIN
  PERFORM 1 FROM users WHERE id = NEW.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account attribution requires an existing account.';
  END IF;

  SELECT * INTO source_row FROM audit_events
  WHERE event_id = NEW.source_event_id
    AND entity_type = 'shell_friction'
    AND entity_id = NEW.journey_entity_id
    AND metadata->>'stage' = 'entry'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account attribution requires prior durable discovery entry evidence.';
  END IF;

  source_time := coalesce((source_row.metadata->>'occurred_at')::timestamptz, source_row.created_at);
  source_channel := lower(coalesce(source_row.metadata->>'source', 'unknown'));
  source_class := source_row.metadata->>'source_class';
  source_path := source_row.metadata->>'entry_path';
  source_entity_kind := source_row.metadata->>'entity_kind';
  source_entity_key := source_row.metadata->>'entity_key';
  source_strength := coalesce(source_row.metadata->>'link_strength', 'unknown_unavailable');
  source_utm_source := source_row.metadata->>'utm_source';
  source_utm_medium := source_row.metadata->>'utm_medium';
  source_utm_campaign := source_row.metadata->>'utm_campaign';
  source_offline_source := source_row.metadata->>'offline_source';

  IF NEW.source_channel <> source_channel
    OR NEW.source_class::text IS DISTINCT FROM source_class
    OR NEW.landing_path IS DISTINCT FROM source_path
    OR NEW.entity_kind IS DISTINCT FROM source_entity_kind
    OR NEW.entity_key IS DISTINCT FROM source_entity_key
    OR NEW.evidence_strength::text <> source_strength
    OR NEW.utm_source IS DISTINCT FROM source_utm_source
    OR NEW.utm_medium IS DISTINCT FROM source_utm_medium
    OR NEW.utm_campaign IS DISTINCT FROM source_utm_campaign
    OR NEW.offline_source IS DISTINCT FROM source_offline_source
    OR NEW.first_touch_at <> source_time THEN
    RAISE EXCEPTION 'Account attribution must snapshot the exact prior discovery entry, including acquisition classification.';
  END IF;

  IF NEW.utm_medium ~* '(^|[_ .-])(cpc|ppc|paid|display|affiliate|sponsored)([_ .-]|$)'
    AND NEW.source_class <> 'paid' THEN
    RAISE EXCEPTION 'Paid campaign evidence cannot be classified as organic.';
  END IF;
  IF NEW.source_class = 'organic_unpaid'
    AND (NEW.evidence_strength <> 'direct_server_observed' OR NEW.source_channel IN ('direct', 'unknown')) THEN
    RAISE EXCEPTION 'Organic acquisition requires direct server evidence and a known non-direct source.';
  END IF;
  IF NEW.source_class = 'direct' AND NEW.source_channel <> 'direct' THEN
    RAISE EXCEPTION 'Direct acquisition requires a direct source channel.';
  END IF;
  IF NEW.evidence_strength = 'unknown_unavailable' AND NEW.source_class <> 'unknown' THEN
    RAISE EXCEPTION 'Unavailable evidence cannot receive a known acquisition class.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_growth_milestone"() RETURNS trigger AS $$
DECLARE
  user_row users%ROWTYPE;
  performer_row performers%ROWTYPE;
  attribution_row account_discovery_attributions%ROWTYPE;
  evidence_row audit_events%ROWTYPE;
  primary_identity_event text;
  profile_exists boolean;
  source_time timestamptz;
  canonical_qualification_snapshot jsonb;
BEGIN
  SELECT * INTO user_row FROM users WHERE id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Growth milestones require an existing account.';
  END IF;
  SELECT * INTO performer_row FROM performers
  WHERE id = NEW.performer_id AND owner_user_id = NEW.user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Growth milestones require durable performer ownership.';
  END IF;
  NEW.event_sequence := nextval(pg_get_serial_sequence('growth_milestones', 'event_sequence'));
  SELECT * INTO attribution_row FROM account_discovery_attributions
  WHERE id = NEW.attribution_id AND user_id = NEW.user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Growth milestones require the account first-touch attribution.';
  END IF;
  SELECT * INTO evidence_row FROM audit_events WHERE event_id = NEW.evidence_event_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Growth milestones require durable server evidence.';
  END IF;
  source_time := coalesce((evidence_row.metadata->>'occurred_at')::timestamptz, evidence_row.created_at);
  IF NEW.occurred_at <> source_time THEN
    RAISE EXCEPTION 'Growth milestone time must match its durable evidence event.';
  END IF;

  IF NEW.milestone_kind = 'qualified_signup' THEN
    IF NEW.environment = 'production'
      AND (attribution_row.source_class <> 'organic_unpaid'
        OR attribution_row.evidence_strength <> 'direct_server_observed') THEN
      RAISE EXCEPTION 'Production OQPS requires directly observed unpaid-organic attribution.';
    END IF;
    IF NEW.occurred_at < attribution_row.linked_at
      OR NEW.occurred_at > attribution_row.linked_at + interval '14 days' THEN
      RAISE EXCEPTION 'Qualified signup must occur within 14 days of the professional-signup attribution link.';
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM performer_public_profiles WHERE performer_id = NEW.performer_id
    ) INTO profile_exists;
    canonical_qualification_snapshot := jsonb_build_object(
      'evaluationVersion', 'oqps-v1',
      'verified', user_row.email_verified_at IS NOT NULL,
      'active', user_row.pro_mode_status = 'active' AND performer_row.is_active = true,
      'unrestricted', user_row.role NOT IN ('admin', 'support')
        AND performer_row.onboarding_status NOT IN ('restricted', 'suspended'),
      'ownsValidProfile', profile_exists AND performer_row.owner_user_id = NEW.user_id,
      'profileComplete', profile_exists
        AND nullif(trim(performer_row.handle), '') IS NOT NULL
        AND nullif(trim(performer_row.display_name), '') IS NOT NULL
        AND nullif(trim(performer_row.bio), '') IS NOT NULL,
      'publiclyEligible', profile_exists
        AND user_row.email_verified_at IS NOT NULL
        AND user_row.role NOT IN ('admin', 'support')
        AND user_row.pro_mode_status = 'active'
        AND performer_row.is_active = true
        AND performer_row.onboarding_status NOT IN ('restricted', 'suspended')
        AND performer_row.visibility_state = 'public'
        AND nullif(trim(performer_row.handle), '') IS NOT NULL
        AND nullif(trim(performer_row.display_name), '') IS NOT NULL
        AND nullif(trim(performer_row.bio), '') IS NOT NULL
    );
    IF user_row.email_verified_at IS NULL
      OR user_row.role IN ('admin', 'support')
      OR user_row.pro_mode_status <> 'active'
      OR performer_row.is_active <> true
      OR performer_row.onboarding_status IN ('restricted', 'suspended')
      OR performer_row.visibility_state <> 'public'
      OR nullif(trim(performer_row.handle), '') IS NULL
      OR nullif(trim(performer_row.display_name), '') IS NULL
      OR nullif(trim(performer_row.bio), '') IS NULL THEN
      RAISE EXCEPTION 'Qualified signup requires a verified, active, unrestricted owner with a valid public profile.';
    END IF;
    IF NOT profile_exists THEN
      RAISE EXCEPTION 'Qualified signup requires a persisted public profile record.';
    END IF;
    SELECT event_type INTO primary_identity_event
    FROM performer_identity_events
    WHERE performer_id = NEW.performer_id AND identity_role = 'primary'
    ORDER BY event_sequence DESC
    LIMIT 1;
    IF primary_identity_event IS DISTINCT FROM 'selected' THEN
      RAISE EXCEPTION 'Qualified signup requires an owner-selected primary professional identity.';
    END IF;
    IF NEW.qualification_snapshot IS DISTINCT FROM canonical_qualification_snapshot THEN
      RAISE EXCEPTION 'Qualified signup snapshot must exactly match server-derived current state.';
    END IF;
    IF evidence_row.event_type <> 'growth.qualified_signup.evaluated'
      OR evidence_row.actor_type <> 'system'
      OR evidence_row.entity_type <> 'performer'
      OR evidence_row.entity_id <> NEW.performer_id
      OR (evidence_row.metadata->>'evaluationId') IS DISTINCT FROM NEW.evidence_event_id::text
      OR (evidence_row.metadata->>'evaluationVersion') IS DISTINCT FROM 'oqps-v1'
      OR (evidence_row.metadata->>'attributionId') IS DISTINCT FROM NEW.attribution_id::text
      OR evidence_row.metadata->'qualificationSnapshot' IS DISTINCT FROM NEW.qualification_snapshot THEN
      RAISE EXCEPTION 'Qualified signup requires a same-time authoritative server evaluation.';
    END IF;
  ELSE
    IF NEW.occurred_at < attribution_row.linked_at
      OR NEW.occurred_at > attribution_row.linked_at + interval '30 days' THEN
      RAISE EXCEPTION 'First value must occur within 30 days of the professional-signup attribution link.';
    END IF;
    IF NEW.value_kind = 'profile_published' AND NOT coalesce((
      evidence_row.event_type = 'performer_visibility.update'
      AND evidence_row.entity_type = 'performer'
      AND evidence_row.entity_id = NEW.performer_id
      AND evidence_row.next_status = 'public'
      AND evidence_row.metadata->>'publiclyEligible' = 'true'
    ), false) THEN
      RAISE EXCEPTION 'Profile publication value requires an authoritative eligible-publication transition.';
    ELSIF NEW.value_kind = 'event_published' AND NOT coalesce((
      evidence_row.event_type = 'performer_event.publish'
      AND evidence_row.entity_type = 'performer_event'
      AND EXISTS (SELECT 1 FROM performer_events WHERE id = evidence_row.entity_id AND performer_id = NEW.performer_id AND status = 'published')
    ), false) THEN
      RAISE EXCEPTION 'Event publication value requires an authoritative published event.';
    ELSIF NEW.value_kind = 'live_room_completed' AND NOT coalesce((
      evidence_row.event_type = 'session.closeout'
      AND evidence_row.entity_type = 'gig_session'
      AND EXISTS (SELECT 1 FROM gig_sessions WHERE id = evidence_row.entity_id AND performer_id = NEW.performer_id AND status = 'closed')
    ), false) THEN
      RAISE EXCEPTION 'Live-room value requires an authoritative completed room.';
    ELSIF NEW.value_kind = 'release_ready' AND NOT coalesce((
      evidence_row.event_type = 'music_release.readiness_pass'
      AND evidence_row.entity_type = 'music_release'
      AND EXISTS (SELECT 1 FROM music_releases WHERE id = evidence_row.entity_id AND performer_id = NEW.performer_id AND status IN ('ready', 'scheduled', 'published'))
    ), false) THEN
      RAISE EXCEPTION 'Release value requires authoritative readiness evidence.';
    ELSIF NEW.value_kind = 'inquiry_received' AND NOT coalesce((
      evidence_row.event_type IN ('booking_inquiry.received', 'partnership_inquiry.received')
      AND evidence_row.entity_type = 'inquiry'
      AND evidence_row.metadata->>'performerId' = NEW.performer_id::text
    ), false) THEN
      RAISE EXCEPTION 'Inquiry value requires an authoritative non-money inquiry event.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_protect_wave1_linked_audit_evidence"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM account_discovery_attributions WHERE source_event_id = OLD.event_id
  ) OR EXISTS (
    SELECT 1 FROM growth_milestones WHERE evidence_event_id = OLD.event_id
  ) THEN
    RAISE EXCEPTION 'Audit evidence linked to acquisition or growth records is immutable.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "performer_identity_events_validate"
BEFORE INSERT ON "performer_identity_events"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_performer_identity_event"();
--> statement-breakpoint
CREATE TRIGGER "performer_intent_events_validate"
BEFORE INSERT ON "performer_intent_events"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_performer_intent_event"();
--> statement-breakpoint
CREATE TRIGGER "performer_capability_grant_events_validate"
BEFORE INSERT ON "performer_capability_grant_events"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_performer_capability_decision"();
--> statement-breakpoint
CREATE TRIGGER "performer_authority_events_validate"
BEFORE INSERT ON "performer_authority_events"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_performer_authority_decision"();
--> statement-breakpoint
CREATE TRIGGER "account_discovery_attributions_validate"
BEFORE INSERT ON "account_discovery_attributions"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_account_discovery_attribution"();
--> statement-breakpoint
CREATE TRIGGER "growth_milestones_validate"
BEFORE INSERT ON "growth_milestones"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_growth_milestone"();
--> statement-breakpoint
CREATE TRIGGER "performer_identity_events_append_only"
BEFORE UPDATE OR DELETE ON "performer_identity_events"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_wave1_immutable_mutation"();
--> statement-breakpoint
CREATE TRIGGER "performer_intent_events_append_only"
BEFORE UPDATE OR DELETE ON "performer_intent_events"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_wave1_immutable_mutation"();
--> statement-breakpoint
CREATE TRIGGER "performer_capability_grant_events_append_only"
BEFORE UPDATE OR DELETE ON "performer_capability_grant_events"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_wave1_immutable_mutation"();
--> statement-breakpoint
CREATE TRIGGER "performer_authority_events_append_only"
BEFORE UPDATE OR DELETE ON "performer_authority_events"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_wave1_immutable_mutation"();
--> statement-breakpoint
CREATE TRIGGER "account_discovery_attributions_append_only"
BEFORE UPDATE OR DELETE ON "account_discovery_attributions"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_wave1_immutable_mutation"();
--> statement-breakpoint
CREATE TRIGGER "growth_milestones_append_only"
BEFORE UPDATE OR DELETE ON "growth_milestones"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_wave1_immutable_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audit_events_protect_wave1_linked_evidence"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "sway_protect_wave1_linked_audit_evidence"();
