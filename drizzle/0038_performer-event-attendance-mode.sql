CREATE TYPE "public"."performer_event_attendance_mode" AS ENUM('walk_in', 'external_rsvp', 'external_ticket', 'native_ticket');--> statement-breakpoint
ALTER TABLE "performer_events" ADD COLUMN "attendance_mode" "performer_event_attendance_mode";--> statement-breakpoint
CREATE FUNCTION "sway_sync_legacy_performer_event_attendance_mode"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Old application versions do not send attendance_mode. Preserve their
  -- legacy native-ticket and RSVP intent during a rolling deploy without
  -- overriding an explicit attendance_mode sent by the new writer.
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
    IF NEW.ticketing_mode = 'native_ga' THEN
      NEW.attendance_mode := 'native_ticket';
    ELSIF NEW.external_ticket_label = 'RSVP' THEN
      NEW.attendance_mode := 'external_rsvp';
    ELSE
      NEW.attendance_mode := 'external_ticket';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "performer_events_legacy_attendance_mode_sync"
BEFORE INSERT OR UPDATE OF "ticketing_mode", "external_ticket_url", "external_ticket_label"
ON "performer_events"
FOR EACH ROW
EXECUTE FUNCTION "sway_sync_legacy_performer_event_attendance_mode"();--> statement-breakpoint
UPDATE "performer_events"
SET "attendance_mode" = CASE
  WHEN "ticketing_mode" = 'native_ga' THEN 'native_ticket'::"performer_event_attendance_mode"
  WHEN "external_ticket_label" = 'RSVP' THEN 'external_rsvp'::"performer_event_attendance_mode"
  ELSE 'external_ticket'::"performer_event_attendance_mode"
END
WHERE "attendance_mode" IS NULL;--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_attendance_mode_not_null" CHECK ("attendance_mode" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "performer_events" VALIDATE CONSTRAINT "performer_events_attendance_mode_not_null";--> statement-breakpoint
ALTER TABLE "performer_events" ALTER COLUMN "attendance_mode" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_events" DROP CONSTRAINT "performer_events_attendance_mode_not_null";--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_published_attendance_ready" CHECK ("performer_events"."status" <> 'published' OR "performer_events"."attendance_mode" IN ('walk_in', 'native_ticket') OR "performer_events"."external_ticket_url" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "performer_events" VALIDATE CONSTRAINT "performer_events_published_attendance_ready";--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_published_walk_in_has_location" CHECK ("performer_events"."status" <> 'published' OR "performer_events"."attendance_mode" <> 'walk_in' OR (
      "performer_events"."location_is_tba" = false
      AND "performer_events"."location_name" IS NOT NULL
      AND length(trim("performer_events"."location_name")) > 0
      AND (
        ("performer_events"."location_address" IS NOT NULL AND length(trim("performer_events"."location_address")) > 0)
        OR ("performer_events"."city" IS NOT NULL AND length(trim("performer_events"."city")) > 0)
      )
    )) NOT VALID;--> statement-breakpoint
ALTER TABLE "performer_events" VALIDATE CONSTRAINT "performer_events_published_walk_in_has_location";--> statement-breakpoint
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
    )) NOT VALID;--> statement-breakpoint
ALTER TABLE "performer_events" VALIDATE CONSTRAINT "performer_events_attendance_mode_shape";--> statement-breakpoint
ALTER TABLE "performer_events" DROP CONSTRAINT "performer_events_published_has_external_ticket";
