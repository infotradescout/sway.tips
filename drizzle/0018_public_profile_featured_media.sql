ALTER TABLE "performer_public_profiles"
  ADD COLUMN IF NOT EXISTS "featured_media" jsonb;

ALTER TABLE "performer_profile_previews"
  ADD COLUMN IF NOT EXISTS "featured_media" jsonb;
