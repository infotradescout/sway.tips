CREATE OR REPLACE FUNCTION "sway_validate_rights_declaration_event"() RETURNS trigger AS $$
DECLARE
  declaration_record music_rights_declarations%ROWTYPE;
BEGIN
  SELECT * INTO declaration_record
  FROM music_rights_declarations
  WHERE id = NEW.declaration_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rights declaration event requires an existing declaration.';
  END IF;
  IF NEW.event_type = 'declared' THEN
    IF NEW.actor_user_id <> declaration_record.declared_by_user_id THEN
      RAISE EXCEPTION 'The initial rights declaration event must use its declarer.';
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM audio_project_access_grants authority
      WHERE authority.project_id = declaration_record.project_id
        AND authority.grantee_user_id = NEW.actor_user_id
        AND authority.can_approve = true
        AND authority.revoked_at IS NULL
        AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
    ) THEN
      RAISE EXCEPTION 'Rights declaration review events require active rights-review authority.';
    END IF;
  END IF;

  IF NEW.event_type IN ('verified', 'rejected') AND EXISTS (
    SELECT 1 FROM music_rights_declaration_events event
    WHERE event.declaration_id = NEW.declaration_id
      AND event.event_type IN ('verified', 'rejected', 'revoked')
  ) THEN
    RAISE EXCEPTION 'This rights declaration already has a terminal review event.';
  END IF;
  IF NEW.event_type = 'revoked' AND (
    NOT EXISTS (
      SELECT 1 FROM music_rights_declaration_events event
      WHERE event.declaration_id = NEW.declaration_id AND event.event_type = 'verified'
    ) OR EXISTS (
      SELECT 1 FROM music_rights_declaration_events event
      WHERE event.declaration_id = NEW.declaration_id AND event.event_type = 'revoked'
    )
  ) THEN
    RAISE EXCEPTION 'Only a verified, active rights declaration can be revoked.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
