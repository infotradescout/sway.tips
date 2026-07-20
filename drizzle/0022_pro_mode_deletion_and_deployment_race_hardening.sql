-- Remediation 1 (account deletion / audit permanence): pro_mode_status_events
-- rows are immutable, pseudonymous historical facts. They must survive any
-- future hard deletion of the users row they reference (Sway's own admin
-- account-deletion route scrubs and keeps the row rather than deleting it,
-- but a real hard DELETE of users does exist today in server.ts's signup
-- rollback path when verification-email delivery fails). A live FK here
-- would make an already-committed Pro Mode event block that unrelated
-- cleanup. Dropping the FK, not the column: user_id/actor_user_id remain as
-- permanent uuid references for audit purposes even if the row they once
-- pointed to is later deleted or scrubbed.
ALTER TABLE "pro_mode_status_events" DROP CONSTRAINT "pro_mode_status_events_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "pro_mode_status_events" DROP CONSTRAINT "pro_mode_status_events_actor_user_id_users_id_fk";
--> statement-breakpoint

-- Remediation 4 (deployment-race mitigation): protects any performer record
-- created by application code that predates this Pro Mode migration (i.e. a
-- pre-cutover instance still serving traffic during a Render deploy). Fires
-- once, on performer-record creation, and only initializes an account that is
-- still at the universal 'disabled' default -- the current /api/talent/signup
-- already sets pro_mode_status to 'onboarding' on the users row before it
-- inserts the performers row in the same transaction, so this never
-- double-fires for the current application path. It must not become a
-- general onboarding_status <-> pro_mode_status synchronizer: later updates
-- to performers.onboarding_status are intentionally not observed here.
CREATE OR REPLACE FUNCTION "sway_initialize_pro_mode_from_legacy_performer_creation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_status "pro_mode_status";
  target_status "pro_mode_status";
BEGIN
  SELECT "pro_mode_status" INTO current_status FROM "users" WHERE "id" = NEW."owner_user_id" FOR UPDATE;

  IF current_status IS DISTINCT FROM 'disabled' THEN
    RETURN NEW;
  END IF;

  target_status := CASE NEW."onboarding_status"
    WHEN 'created' THEN 'onboarding'::pro_mode_status
    WHEN 'profile_started' THEN 'onboarding'::pro_mode_status
    WHEN 'gig_ready' THEN 'active'::pro_mode_status
    WHEN 'payments_limited' THEN 'active'::pro_mode_status
    WHEN 'verification_required' THEN 'active'::pro_mode_status
    WHEN 'verified' THEN 'active'::pro_mode_status
    WHEN 'payouts_enabled' THEN 'active'::pro_mode_status
    WHEN 'restricted' THEN 'active'::pro_mode_status
    WHEN 'suspended' THEN 'suspended'::pro_mode_status
    ELSE NULL
  END;

  IF target_status IS NULL THEN
    RAISE EXCEPTION 'sway_initialize_pro_mode_from_legacy_performer_creation: unmapped performers.onboarding_status value %', NEW."onboarding_status";
  END IF;

  UPDATE "users"
  SET "pro_mode_status" = target_status, "pro_mode_status_changed_at" = now()
  WHERE "id" = NEW."owner_user_id";

  INSERT INTO "pro_mode_status_events" ("user_id", "previous_status", "next_status", "reason", "actor_user_id")
  VALUES (
    NEW."owner_user_id",
    'disabled',
    target_status,
    'Legacy-compatible performer creation initialization (sway_initialize_pro_mode_from_legacy_performer_creation).',
    NEW."owner_user_id"
  );

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER "performers_initialize_pro_mode_on_create"
  AFTER INSERT ON "performers"
  FOR EACH ROW EXECUTE FUNCTION "sway_initialize_pro_mode_from_legacy_performer_creation"();
