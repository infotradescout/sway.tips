ALTER TABLE "live_room_processor_events" ADD COLUMN "processing_lease_owner" text;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sway_preserve_live_room_processor_terminal_state"() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('processed', 'ignored', 'terminal_failed') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'live_room_processor_terminal_state_is_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "live_room_processor_terminal_state_guard"
BEFORE UPDATE ON "live_room_processor_events"
FOR EACH ROW EXECUTE FUNCTION "sway_preserve_live_room_processor_terminal_state"();
