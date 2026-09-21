DO $$
DECLARE
  target_performer_id uuid;
  removed_links jsonb;
BEGIN
  SELECT id
    INTO target_performer_id
    FROM performers
   WHERE lower(handle) = 'edgewyze'
   FOR UPDATE;

  -- Fresh databases and profiles that were already cleaned have nothing to do.
  IF target_performer_id IS NULL THEN
    RETURN;
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'label', label,
        'description', description,
        'url', url,
        'kind', kind,
        'sortOrder', sort_order,
        'isActive', is_active
      ) ORDER BY sort_order, id
    ),
    '[]'::jsonb
  )
    INTO removed_links
    FROM performer_profile_links
   WHERE performer_id = target_performer_id
     AND label = 'Platynum-47'
     AND url = 'https://github.com/Platynum-47/Selective-Intelligence';

  IF removed_links = '[]'::jsonb THEN
    RETURN;
  END IF;

  DELETE FROM performer_profile_links
   WHERE performer_id = target_performer_id
     AND label = 'Platynum-47'
     AND url = 'https://github.com/Platynum-47/Selective-Intelligence';

  INSERT INTO audit_events (
    actor_type,
    actor_id,
    entity_type,
    entity_id,
    event_type,
    previous_status,
    next_status,
    metadata
  )
  SELECT
    'account_owner_authorized_system',
    owner_user_id,
    'performer',
    target_performer_id,
    'performer_profile_link.cleanup',
    'legacy_link_present',
    'removed',
    jsonb_build_object(
      'operation', 'edgewyze_public_link_cleanup',
      'removedLinks', removed_links,
      'moneyFieldsChanged', false,
      'accessFieldsChanged', false
    )
  FROM performers
  WHERE id = target_performer_id;
END $$;
