ALTER TABLE "performer_profile_previews" DROP CONSTRAINT "performer_profile_previews_handle_not_reserved";--> statement-breakpoint
ALTER TABLE "performers" DROP CONSTRAINT "performers_handle_not_reserved";--> statement-breakpoint
ALTER TABLE "performer_profile_previews" ADD CONSTRAINT "performer_profile_previews_handle_canonical" CHECK (
  "handle" = trim("handle")
  AND "handle" ~ '^[A-Za-z0-9_-]{1,64}$'
) NOT VALID;--> statement-breakpoint
ALTER TABLE "performer_profile_previews" VALIDATE CONSTRAINT "performer_profile_previews_handle_canonical";--> statement-breakpoint
ALTER TABLE "performer_profile_previews" ADD CONSTRAINT "performer_profile_previews_handle_not_reserved" CHECK (
  lower(trim("handle")) NOT IN (
    'admin', 'api', 'app', 'assets', 'auth', 'billing', 'contact', 'discover',
    'g', 'help', 'login', 'logout', 'overlay', 'p', 'privacy', 'profile',
    'public', 'room', 'settings', 'shells', 'signup', 'support', 'sway',
    'talent', 'terms', 'tickets', 'www'
  )
) NOT VALID;--> statement-breakpoint
ALTER TABLE "performer_profile_previews" VALIDATE CONSTRAINT "performer_profile_previews_handle_not_reserved";--> statement-breakpoint
ALTER TABLE "performers" ADD CONSTRAINT "performers_handle_canonical" CHECK (
  "handle" IS NULL OR (
    "handle" = trim("handle")
    AND "handle" ~ '^[A-Za-z0-9_-]{1,64}$'
  )
) NOT VALID;--> statement-breakpoint
ALTER TABLE "performers" VALIDATE CONSTRAINT "performers_handle_canonical";--> statement-breakpoint
ALTER TABLE "performers" ADD CONSTRAINT "performers_handle_not_reserved" CHECK (
  "handle" IS NULL OR lower(trim("handle")) NOT IN (
    'admin', 'api', 'app', 'assets', 'auth', 'billing', 'contact', 'discover',
    'g', 'help', 'login', 'logout', 'overlay', 'p', 'privacy', 'profile',
    'public', 'room', 'settings', 'shells', 'signup', 'support', 'sway',
    'talent', 'terms', 'tickets', 'www'
  )
) NOT VALID;--> statement-breakpoint
ALTER TABLE "performers" VALIDATE CONSTRAINT "performers_handle_not_reserved";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "performers" AS performer
    INNER JOIN "performer_profile_previews" AS preview
      ON lower(performer."handle") = lower(preview."handle")
    WHERE performer."handle" IS NOT NULL
      AND preview."is_active" = true
      AND preview."claimed_performer_id" IS DISTINCT FROM performer."id"
  ) THEN
    RAISE unique_violation USING
      CONSTRAINT = 'sway_global_performer_handle_unique',
      MESSAGE = 'An active performer and performer preview reserve the same public handle.';
  END IF;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "sway_enforce_performer_handle_namespace"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_handle text;
BEGIN
  IF NEW."handle" IS NULL THEN
    RETURN NEW;
  END IF;

  canonical_handle := lower(NEW."handle");
  PERFORM pg_advisory_xact_lock(
    hashtextextended('sway:performer-handle:v1:' || canonical_handle, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM "performer_profile_previews" AS preview
    WHERE preview."is_active" = true
      AND lower(preview."handle") = canonical_handle
      AND preview."claimed_performer_id" IS DISTINCT FROM NEW."id"
  ) THEN
    RAISE unique_violation USING
      CONSTRAINT = 'sway_global_performer_handle_unique',
      MESSAGE = 'This public handle is reserved by another performer profile.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "sway_enforce_preview_handle_namespace"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  canonical_handle text;
BEGIN
  IF NEW."is_active" = false THEN
    RETURN NEW;
  END IF;

  canonical_handle := lower(NEW."handle");
  PERFORM pg_advisory_xact_lock(
    hashtextextended('sway:performer-handle:v1:' || canonical_handle, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM "performers" AS performer
    WHERE performer."handle" IS NOT NULL
      AND lower(performer."handle") = canonical_handle
      AND performer."id" IS DISTINCT FROM NEW."claimed_performer_id"
  ) THEN
    RAISE unique_violation USING
      CONSTRAINT = 'sway_global_performer_handle_unique',
      MESSAGE = 'This public handle is reserved by another performer profile.';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "performers_global_handle_namespace"
BEFORE INSERT OR UPDATE OF "handle"
ON "performers"
FOR EACH ROW
EXECUTE FUNCTION "sway_enforce_performer_handle_namespace"();--> statement-breakpoint
CREATE TRIGGER "performer_profile_previews_global_handle_namespace"
BEFORE INSERT OR UPDATE OF "handle", "is_active", "claimed_performer_id"
ON "performer_profile_previews"
FOR EACH ROW
EXECUTE FUNCTION "sway_enforce_preview_handle_namespace"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sway_sync_legacy_performer_event_attendance_mode"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.attendance_mode IS NULL THEN
    IF NEW.ticketing_mode = 'native_ga' THEN
      NEW.attendance_mode := 'native_ticket';
    ELSIF NEW.external_ticket_label = 'RSVP' THEN
      NEW.attendance_mode := 'external_rsvp';
    ELSE
      NEW.attendance_mode := 'external_ticket';
    END IF;
  ELSIF TG_OP = 'UPDATE'
    AND NEW.attendance_mode IS NOT DISTINCT FROM OLD.attendance_mode
    AND (
      NEW.ticketing_mode IS DISTINCT FROM OLD.ticketing_mode
      OR NEW.external_ticket_url IS DISTINCT FROM OLD.external_ticket_url
      OR NEW.external_ticket_label IS DISTINCT FROM OLD.external_ticket_label
    )
  THEN
    -- PostgreSQL cannot distinguish an omitted column from an explicit
    -- same-value assignment in a row trigger. Preserve a still-valid mode
    -- and infer legacy intent only after the old mode becomes incompatible.
    IF (
      NEW.attendance_mode = 'walk_in'
      AND NEW.ticketing_mode = 'external'
      AND NEW.external_ticket_url IS NULL
      AND NEW.external_ticket_label IS NULL
    ) OR (
      NEW.attendance_mode = 'external_rsvp'
      AND NEW.ticketing_mode = 'external'
      AND (
        (NEW.external_ticket_url IS NULL AND NEW.external_ticket_label IS NULL)
        OR (NEW.external_ticket_url IS NOT NULL AND NEW.external_ticket_label = 'RSVP')
      )
    ) OR (
      NEW.attendance_mode = 'external_ticket'
      AND NEW.ticketing_mode = 'external'
      AND (
        (NEW.external_ticket_url IS NULL AND NEW.external_ticket_label IS NULL)
        OR (
          NEW.external_ticket_url IS NOT NULL
          AND NEW.external_ticket_label IN ('Get tickets', 'View details')
        )
      )
    ) OR (
      NEW.attendance_mode = 'native_ticket'
      AND NEW.ticketing_mode = 'native_ga'
      AND NEW.external_ticket_url IS NULL
      AND NEW.external_ticket_label IS NULL
    ) THEN
      NULL;
    ELSIF NEW.ticketing_mode = 'native_ga' THEN
      NEW.attendance_mode := 'native_ticket';
    ELSIF NEW.external_ticket_label = 'RSVP' THEN
      NEW.attendance_mode := 'external_rsvp';
    ELSE
      NEW.attendance_mode := 'external_ticket';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
