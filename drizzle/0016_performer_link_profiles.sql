ALTER TABLE "performer_public_profiles" ADD COLUMN IF NOT EXISTS "booking_email" text;
ALTER TABLE "performer_public_profiles" ADD COLUMN IF NOT EXISTS "booking_phone" text;
ALTER TABLE "performer_public_profiles" ADD COLUMN IF NOT EXISTS "facebook_url" text;
ALTER TABLE "performer_public_profiles" ADD COLUMN IF NOT EXISTS "specialties" jsonb;

CREATE TABLE IF NOT EXISTS "performer_partner_entitlements" (
  "performer_id" uuid PRIMARY KEY NOT NULL REFERENCES "performers"("id") ON DELETE CASCADE,
  "granted_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "partner_kind" text NOT NULL DEFAULT 'brand',
  "terms_version" text NOT NULL,
  "terms_snapshot" jsonb NOT NULL,
  "note" text,
  "granted_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "performer_partner_entitlements_terms_version_idx"
  ON "performer_partner_entitlements" ("terms_version");

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
