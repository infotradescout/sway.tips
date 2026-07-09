CREATE TABLE IF NOT EXISTS "performer_public_profiles" (
  "performer_id" uuid PRIMARY KEY REFERENCES "performers"("id"),
  "headline" text,
  "city" text,
  "avatar_url" text,
  "instagram_url" text,
  "tiktok_url" text,
  "youtube_url" text,
  "soundcloud_url" text,
  "website_url" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "performer_public_profiles_updated_at_idx"
  ON "performer_public_profiles" ("updated_at");
