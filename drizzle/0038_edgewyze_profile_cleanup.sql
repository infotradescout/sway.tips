DO $$
DECLARE
  target_performer_id uuid;
  target_owner_user_id uuid;
  source_count integer;
BEGIN
  SELECT count(*)::integer
    INTO source_count
    FROM performers
   WHERE lower(handle) = 'platynum-47';

  -- Fresh databases and accounts that were already corrected have nothing to do.
  IF source_count = 0 THEN
    RETURN;
  END IF;

  IF source_count <> 1 THEN
    RAISE EXCEPTION 'EdgeWyze cleanup expected exactly one Platynum-47 performer, found %.', source_count;
  END IF;

  SELECT id, owner_user_id
    INTO target_performer_id, target_owner_user_id
    FROM performers
   WHERE lower(handle) = 'platynum-47'
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM performers
     WHERE lower(handle) = 'edgewyze'
       AND id <> target_performer_id
  ) THEN
    RAISE EXCEPTION 'EdgeWyze cleanup cannot claim an existing performer handle.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM performer_profile_previews
     WHERE lower(handle) = 'edgewyze'
       AND claimed_performer_id IS DISTINCT FROM target_performer_id
  ) THEN
    RAISE EXCEPTION 'EdgeWyze cleanup cannot conflict with an existing profile preview.';
  END IF;

  UPDATE users
     SET display_name = 'EdgeWyze',
         updated_at = now()
   WHERE id = target_owner_user_id;

  UPDATE performers
     SET handle = 'edgewyze',
         display_name = 'EdgeWyze',
         bio = 'EdgeWyze pairs human-written lyrics with an original virtual voice and generative music production.',
         updated_at = now()
   WHERE id = target_performer_id;

  INSERT INTO performer_public_profiles (
    performer_id,
    headline,
    specialties,
    updated_at
  ) VALUES (
    target_performer_id,
    'Human-written lyrics. Original virtual artist.',
    '["Songwriting", "Original music", "Virtual performance"]'::jsonb,
    now()
  )
  ON CONFLICT (performer_id) DO UPDATE
    SET headline = EXCLUDED.headline,
        specialties = EXCLUDED.specialties,
        updated_at = EXCLUDED.updated_at;

  INSERT INTO audit_events (
    actor_type,
    actor_id,
    entity_type,
    entity_id,
    event_type,
    previous_status,
    next_status,
    metadata
  ) VALUES (
    'account_owner_authorized_system',
    target_owner_user_id,
    'performer',
    target_performer_id,
    'performer_identity.correct',
    'Platynum-47',
    'edgewyze',
    jsonb_build_object(
      'operation', 'edgewyze_profile_cleanup',
      'accountDisplayName', 'EdgeWyze',
      'performerDisplayName', 'EdgeWyze',
      'moneyFieldsChanged', false,
      'accessFieldsChanged', false
    )
  );
END $$;
