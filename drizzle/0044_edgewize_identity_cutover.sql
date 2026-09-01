SET LOCAL lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  target_performer_id constant uuid := 'b705a2fb-9491-4fa8-b9e9-b14b7e1c1289';
  target_owner_user_id uuid;
  current_handle text;
  previous_display_name text;
BEGIN
  SELECT p."owner_user_id", lower(p."handle"), p."display_name"
    INTO target_owner_user_id, current_handle, previous_display_name
    FROM "performers" p
   WHERE p."id" = target_performer_id
   FOR UPDATE;

  -- Fresh databases without Thomas's performer account have no identity to
  -- cut over. Production is verified separately before this migration ships.
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF current_handle = 'edgewize' THEN
    RETURN;
  END IF;

  IF current_handle IS DISTINCT FROM 'edgewyze' THEN
    RAISE EXCEPTION 'EdgeWize cutover expected performer % to own edgewyze, found %.',
      target_performer_id, current_handle;
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM "performer_handle_claims" c
     WHERE c."normalized_handle" = 'edgewize'
       AND c."performer_id" = target_performer_id
       AND c."claim_kind" = 'reservation'
  ) THEN
    RAISE EXCEPTION 'EdgeWize cutover requires the verified private reservation.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM "performer_handle_claims" c
     WHERE c."normalized_handle" = 'edgewyze'
       AND c."performer_id" = target_performer_id
       AND c."claim_kind" = 'canonical'
  ) THEN
    RAISE EXCEPTION 'EdgeWize cutover requires the verified historical canonical claim.';
  END IF;

  UPDATE "users"
     SET "display_name" = 'EdgeWize',
         "updated_at" = now()
   WHERE "id" = target_owner_user_id;

  -- The installed claim trigger atomically promotes edgewize from reservation
  -- to canonical and permanently demotes edgewyze to a public redirect.
  UPDATE "performers"
     SET "handle" = 'edgewize',
         "display_name" = 'EdgeWize',
         "bio" = replace("bio", 'EdgeWyze', 'EdgeWize'),
         "updated_at" = now()
   WHERE "id" = target_performer_id;

  IF NOT EXISTS (
    SELECT 1
      FROM "performer_handle_claims" c
     WHERE c."normalized_handle" = 'edgewize'
       AND c."performer_id" = target_performer_id
       AND c."claim_kind" = 'canonical'
  ) OR NOT EXISTS (
    SELECT 1
      FROM "performer_handle_claims" c
     WHERE c."normalized_handle" = 'edgewyze'
       AND c."performer_id" = target_performer_id
       AND c."claim_kind" = 'redirect'
  ) THEN
    RAISE EXCEPTION 'EdgeWize cutover failed to establish canonical and redirect claims.';
  END IF;

  INSERT INTO "audit_events" (
    "actor_type",
    "actor_id",
    "entity_type",
    "entity_id",
    "event_type",
    "previous_status",
    "next_status",
    "metadata"
  ) VALUES (
    'account_owner_authorized_system',
    target_owner_user_id,
    'performer',
    target_performer_id,
    'performer_identity.correct',
    current_handle,
    'edgewize',
    jsonb_build_object(
      'operation', 'edgewize_identity_cutover',
      'previousDisplayName', previous_display_name,
      'accountDisplayName', 'EdgeWize',
      'performerDisplayName', 'EdgeWize',
      'historicalRedirect', 'edgewyze',
      'moneyFieldsChanged', false,
      'accessFieldsChanged', false
    )
  );
END $$;
