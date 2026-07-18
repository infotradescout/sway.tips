CREATE TABLE IF NOT EXISTS "performer_profile_previews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "handle" text NOT NULL,
  "claimed_performer_id" uuid REFERENCES "performers"("id"),
  "display_name" text NOT NULL,
  "bio" text,
  "headline" text,
  "specialties" jsonb,
  "city" text,
  "avatar_url" text,
  "facebook_url" text,
  "instagram_url" text,
  "tiktok_url" text,
  "youtube_url" text,
  "soundcloud_url" text,
  "website_url" text,
  "links" jsonb,
  "metadata" jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "performer_profile_previews_handle_not_reserved"
    CHECK (lower("handle") NOT IN (
      'admin', 'api', 'app', 'assets', 'auth', 'billing', 'contact', 'discover',
      'g', 'help', 'login', 'logout', 'overlay', 'p', 'privacy', 'profile',
      'public', 'room', 'settings', 'shells', 'signup', 'support', 'sway',
      'talent', 'terms', 'www'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS "performer_profile_previews_handle_lower_idx"
  ON "performer_profile_previews" (lower("handle"));

CREATE UNIQUE INDEX IF NOT EXISTS "performer_profile_previews_claimed_performer_idx"
  ON "performer_profile_previews" ("claimed_performer_id");

CREATE INDEX IF NOT EXISTS "performer_profile_previews_active_idx"
  ON "performer_profile_previews" ("is_active");
