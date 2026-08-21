CREATE FUNCTION "sway_protect_professional_setup_receipt"() RETURNS trigger AS $$
BEGIN
  IF OLD.event_type = 'professional_setup.update'
    OR (TG_OP = 'UPDATE' AND NEW.event_type = 'professional_setup.update') THEN
    RAISE EXCEPTION 'Professional setup mutation receipts are append-only.';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "audit_events_protect_professional_setup_receipt"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "sway_protect_professional_setup_receipt"();
