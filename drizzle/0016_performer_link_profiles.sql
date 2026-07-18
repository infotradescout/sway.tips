ALTER TABLE "performer_public_profiles" ADD COLUMN IF NOT EXISTS "booking_email" text;
ALTER TABLE "performer_public_profiles" ADD COLUMN IF NOT EXISTS "booking_phone" text;
ALTER TABLE "performer_public_profiles" ADD COLUMN IF NOT EXISTS "facebook_url" text;
ALTER TABLE "performer_public_profiles" ADD COLUMN IF NOT EXISTS "specialties" jsonb;

ALTER TABLE "performers"
  ADD CONSTRAINT "performers_handle_not_reserved"
  CHECK (
    "handle" IS NULL OR lower("handle") NOT IN (
      'admin', 'api', 'app', 'assets', 'auth', 'billing', 'contact', 'discover',
      'g', 'help', 'login', 'logout', 'overlay', 'p', 'privacy', 'profile',
      'public', 'room', 'settings', 'shells', 'signup', 'support', 'sway',
      'talent', 'terms', 'www'
    )
  );

CREATE TABLE IF NOT EXISTS "performer_partner_entitlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL REFERENCES "performers"("id"),
  "granted_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "partner_kind" text NOT NULL DEFAULT 'brand',
  "terms_version" text NOT NULL,
  "terms_hash" text NOT NULL,
  "terms_text" text NOT NULL,
  "terms_snapshot" jsonb NOT NULL,
  "note" text,
  "granted_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "performer_partner_entitlements_performer_kind_idx"
  ON "performer_partner_entitlements" ("performer_id", "partner_kind");

CREATE INDEX IF NOT EXISTS "performer_partner_entitlements_terms_version_idx"
  ON "performer_partner_entitlements" ("terms_version");

CREATE TABLE IF NOT EXISTS "performer_partner_entitlement_status_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entitlement_id" uuid NOT NULL REFERENCES "performer_partner_entitlements"("id"),
  "performer_id" uuid NOT NULL REFERENCES "performers"("id"),
  "status" text NOT NULL,
  "reason" text,
  "actor_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE "performer_partner_entitlement_status_events"
  ADD CONSTRAINT "performer_partner_entitlement_status_events_status_allowed"
  CHECK ("status" IN ('active', 'suspended'));

CREATE INDEX IF NOT EXISTS "performer_partner_entitlement_status_events_entitlement_created_idx"
  ON "performer_partner_entitlement_status_events" ("entitlement_id", "created_at");

CREATE INDEX IF NOT EXISTS "performer_partner_entitlement_status_events_performer_created_idx"
  ON "performer_partner_entitlement_status_events" ("performer_id", "created_at");

CREATE TABLE IF NOT EXISTS "performer_partner_terms_acceptances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entitlement_id" uuid NOT NULL REFERENCES "performer_partner_entitlements"("id"),
  "performer_id" uuid NOT NULL REFERENCES "performers"("id"),
  "account_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "terms_version" text NOT NULL,
  "terms_hash" text NOT NULL,
  "terms_text" text NOT NULL,
  "terms_snapshot" jsonb NOT NULL,
  "accepted_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "performer_partner_terms_acceptances_receipt_idx"
  ON "performer_partner_terms_acceptances" ("entitlement_id", "account_user_id", "terms_hash");

CREATE INDEX IF NOT EXISTS "performer_partner_terms_acceptances_performer_accepted_idx"
  ON "performer_partner_terms_acceptances" ("performer_id", "accepted_at");

CREATE OR REPLACE FUNCTION "sway_validate_partner_acceptance_receipt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "performer_partner_entitlements" entitlement
    INNER JOIN "performers" performer ON performer."id" = entitlement."performer_id"
    WHERE entitlement."id" = NEW."entitlement_id"
      AND entitlement."performer_id" = NEW."performer_id"
      AND performer."owner_user_id" = NEW."account_user_id"
      AND entitlement."terms_version" = NEW."terms_version"
      AND entitlement."terms_hash" = NEW."terms_hash"
      AND entitlement."terms_text" = NEW."terms_text"
      AND entitlement."terms_snapshot" = NEW."terms_snapshot"
  ) THEN
    RAISE EXCEPTION 'Brand Partner acceptance must be recorded by the performer owner against the exact granted terms';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "performer_partner_terms_acceptances_validate_owner_terms"
  BEFORE INSERT ON "performer_partner_terms_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "sway_validate_partner_acceptance_receipt"();

CREATE TABLE IF NOT EXISTS "performer_profile_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL REFERENCES "performers"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "description" text,
  "url" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'other',
  "sort_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "performer_profile_links_performer_sort_idx"
  ON "performer_profile_links" ("performer_id", "sort_order");

CREATE INDEX IF NOT EXISTS "performer_profile_links_performer_active_idx"
  ON "performer_profile_links" ("performer_id", "is_active");

CREATE OR REPLACE FUNCTION "sway_reject_immutable_partner_record_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Sway Brand Partner grants, status events, and acceptance receipts are append-only';
END;
$$;

CREATE TRIGGER "performer_partner_entitlements_immutable"
  BEFORE UPDATE OR DELETE ON "performer_partner_entitlements"
  FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_partner_record_mutation"();

CREATE TRIGGER "performer_partner_entitlement_status_events_immutable"
  BEFORE UPDATE OR DELETE ON "performer_partner_entitlement_status_events"
  FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_partner_record_mutation"();

CREATE TRIGGER "performer_partner_terms_acceptances_immutable"
  BEFORE UPDATE OR DELETE ON "performer_partner_terms_acceptances"
  FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_partner_record_mutation"();
