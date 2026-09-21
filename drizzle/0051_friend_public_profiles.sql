-- Operator-authorized publication of four existing, linked professional identities.
-- This is not an account claim, invitation, onboarding transition, or payment grant.
-- Sources, baseline evidence, and audit-based rollback: docs/profile-facts-2026-09-08.md.
-- A missing identity is a no-op; a present identity with unexpected state aborts.
DO $friend_public_profiles$
DECLARE
  migration_key CONSTANT text := '0051_friend_public_profiles_v1';
  publication_event CONSTANT text := 'performer_public_profile.operator_publish';
  target record;
  performer_before performers%ROWTYPE;
  preview_source performer_profile_previews%ROWTYPE;
  profile_after performer_public_profiles%ROWTYPE;
  before_snapshot jsonb;
  after_snapshot jsonb;
  applied_at timestamptz;
BEGIN
  -- Serialize this operator action, including manual retries outside Drizzle.
  PERFORM pg_advisory_xact_lock(hashtextextended(migration_key, 0));

  -- Hold moderation writes until the checks and publication commit together.
  -- These short-lived read locks do not alter or dismiss any moderation record.
  LOCK TABLE active_blocks, moderation_events IN SHARE MODE;

  FOR target IN
    SELECT * FROM (VALUES
      (
        'b1b0e4d9-d4a8-4526-b49a-f5c4e464cfcd'::uuid,
        '87b3512f-a5a6-4b1f-b80b-1a94f9575a98'::uuid,
        '34607bf4-37ca-43d5-b61f-3d684a410e32'::uuid,
        'bubbakhain', 'Bubba Khain',
        'https://sway.tips/assets/bubba-khain-avatar.jpg',
        'Bubba Khain is a hip-hop artist whose catalog includes the four-track EP 1,040 Degrees and collaborations with Drew Maze on Major and FAKE LOVE. Explore the music on Apple Music and Audiomack.',
        'Hip-hop artist · 1,040 Degrees',
        '["musician"]'::jsonb,
        '["Hip-Hop/Rap"]'::jsonb,
        NULL::text, NULL::text, NULL::text,
        '[{"label":"Listen on Apple Music","url":"https://music.apple.com/us/artist/bubba-khain/1450529807","kind":"other"},{"label":"Listen on Audiomack","url":"https://audiomack.com/bubba-khain","kind":"other"},{"label":"1,040 Degrees EP","url":"https://audiomack.com/bubba-khain/album/1040-degrees","kind":"other"}]'::jsonb,
        '[{"url":"https://music.apple.com/us/artist/bubba-khain/1450529807","supports":["artist identity","1,040 Degrees EP","Major and FAKE LOVE with Drew Maze"],"method":"public_page"},{"url":"https://audiomack.com/bubba-khain/album/1040-degrees","supports":["Hip-Hop/Rap","four-track EP"],"method":"public_page"}]'::jsonb,
        '[]'::jsonb
      ),
      (
        'ed8116ce-8255-4ff8-bfec-6a57ec9568cf'::uuid,
        '7e78b206-060e-4fed-bb77-6d45113a3b4b'::uuid,
        '51e64828-fc4d-4e60-a743-afd993674141'::uuid,
        'calliehines', 'Callie Hines',
        'https://sway.tips/assets/callie-hines-avatar.jpg',
        'Callie Hines is a Louisiana singer-songwriter and acoustic guitarist whose music draws on folk, Americana, bluegrass and country. The six-track debut EP Tell Me Why I''ve Come Home pairs original songwriting with an acoustic ensemble.',
        'Singer-songwriter · Acoustic guitar · Americana and folk',
        '["musician"]'::jsonb,
        '["Singer-songwriter","Acoustic guitar","Americana","Folk","Bluegrass","Country"]'::jsonb,
        'https://www.facebook.com/thecalliehines/',
        'https://www.instagram.com/thecalliehines/',
        NULL::text,
        '[{"label":"Listen on Spotify","url":"https://open.spotify.com/artist/2xxnkOlnJBeYGnxkcK5O5g","kind":"other"},{"label":"Tell Me Why I’ve Come Home EP","url":"https://open.spotify.com/album/2OPIiznw7NwXxvyjJaCNro","kind":"other"},{"label":"Read the OffBeat review","url":"https://www.offbeat.com/music/callie-hines-tell-me-why-ive-come-home-ep/","kind":"press"}]'::jsonb,
        '[{"url":"https://www.offbeat.com/music/callie-hines-tell-me-why-ive-come-home-ep/","supports":["Louisiana singer-songwriter","acoustic guitar","Americana, folk, bluegrass and country","six-track debut EP","Instagram identity"],"method":"public_page"},{"url":"https://open.spotify.com/artist/2xxnkOlnJBeYGnxkcK5O5g","supports":["artist and listening destination"],"method":"search_index"},{"url":"https://open.spotify.com/album/2OPIiznw7NwXxvyjJaCNro","supports":["EP and listening destination"],"method":"search_index"},{"url":"https://www.fox10tv.com/2023/03/24/chatting-with-callie-hines/","supports":["Facebook and Instagram identities"],"method":"search_index"}]'::jsonb,
        '[]'::jsonb
      ),
      (
        'da855e85-9f7a-469e-9d9d-8c8e1ce20b96'::uuid,
        'e66685f1-885b-47c0-ac05-a4cf1e623087'::uuid,
        '59a1b6cf-854e-47f2-aa8f-d1424abe868c'::uuid,
        'coreymack', 'Corey Mack',
        'https://img1.wsimg.com/isteam/ip/507cdd9e-ba65-48f1-ac5c-290e6c33023b/72E6855B-ABEB-492D-8EA4-0DAB48CAA65E.jpeg',
        'Corey Mack brings together stand-up comedy, beatboxing, DJ sets and crowd hosting. Known as The Jester of Sound and Soul, Corey performs as a comedian, musician, MC and event host. Booking inquiries are available through Corey''s official website.',
        'The Jester of Sound and Soul',
        '["comedian","musician","dj","host"]'::jsonb,
        '["Stand-up comedy","Beatboxing","DJ","MC","Event hosting"]'::jsonb,
        NULL::text, NULL::text, 'https://coreymack.us/',
        '[{"label":"Bookings and official website","url":"https://coreymack.us/","kind":"booking"},{"label":"Watch Corey’s opening set","description":"Opening set for Theo Von’s No Offense.","url":"https://www.youtube.com/watch?v=_KzoiR1RgrU","kind":"other"}]'::jsonb,
        '[{"url":"https://coreymack.us/","supports":["stand-up comedy","beatboxing","DJ","MC and event hosting","The Jester of Sound and Soul","booking destination"],"method":"public_page"},{"url":"https://www.youtube.com/watch?v=_KzoiR1RgrU","supports":["opening-set video identity and title"],"method":"search_index"}]'::jsonb,
        '[]'::jsonb
      ),
      (
        'bc1c60c2-2ec1-4967-ad2f-b099adfcbb7c'::uuid,
        'bb5a762c-4a0f-47c2-bba9-bb83590764e9'::uuid,
        'd834d8c0-3374-4ec9-bea8-93419fd6df0e'::uuid,
        'drewmaze', 'Drew Maze',
        'https://sway.tips/assets/drew-maze-avatar.jpg',
        'Drew Maze is a rapper and producer and the owner of Lo-Ram Studios, a new record label. Drew''s released music includes Dead People, The Honorable and Mutual, alongside collaborations with Bubba Khain on Major and FAKE LOVE.',
        'Rapper · Producer · Owner of Lo-Ram Studios',
        '["musician","producer"]'::jsonb,
        '["Rap","Music production","Record label"]'::jsonb,
        NULL::text, NULL::text, NULL::text,
        '[{"label":"Listen on Apple Music","url":"https://music.apple.com/us/artist/drew-maze/1528296799","kind":"other"},{"label":"Major with Bubba Khain","url":"https://music.apple.com/us/album/major-feat-drew-maze-single/1760366176","kind":"other"},{"label":"FAKE LOVE with Bubba Khain","url":"https://music.apple.com/us/album/fake-love-feat-drew-maze-single/1760798094","kind":"other"}]'::jsonb,
        '[{"url":"https://music.apple.com/us/artist/drew-maze/1528296799","supports":["artist identity","Dead People, The Honorable and Mutual","Major and FAKE LOVE collaborations"],"method":"public_page"}]'::jsonb,
        '[{"fact":"Drew Maze is a rapper and producer.","source":"user_confirmation","confirmedOn":"2026-09-08"},{"fact":"Drew Maze owns Lo-Ram Studios, a new record label.","source":"user_confirmation","confirmedOn":"2026-09-08","independentlyWebCorroborated":false}]'::jsonb
      )
    ) AS reviewed_targets (
      performer_id, owner_user_id, preview_id, handle, display_name, avatar_url,
      bio, headline, roles, specialties, facebook_url, instagram_url, website_url,
      links, sources, user_confirmed_facts
    )
  LOOP
    -- Never republish over a subsequent owner edit, unpublish, or rollback.
    IF EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.actor_type = 'operator'
        AND a.entity_type = 'performer'
        AND a.entity_id = target.performer_id
        AND a.event_type = publication_event
        AND a.metadata->>'migrationId' = migration_key
    ) THEN
      CONTINUE;
    END IF;

    -- Fresh installations do not acquire these people, users, or preview data.
    IF NOT EXISTS (
      SELECT 1 FROM performers p
      WHERE p.id = target.performer_id OR lower(p.handle) = target.handle
    ) AND NOT EXISTS (
      SELECT 1 FROM performer_profile_previews pv
      WHERE pv.id = target.preview_id OR lower(pv.handle) = target.handle
    ) AND NOT EXISTS (
      SELECT 1 FROM performer_handle_claims hc
      WHERE hc.normalized_handle = target.handle
    ) THEN
      CONTINUE;
    END IF;

    PERFORM 1 FROM users u
    WHERE u.id = target.owner_user_id
      AND u.pro_mode_status NOT IN ('suspended', 'revoked')
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Friend profile publication: missing or restricted owner for %', target.handle;
    END IF;

    SELECT p.* INTO performer_before FROM performers p
    WHERE p.id = target.performer_id
    FOR UPDATE;
    IF NOT FOUND
      OR performer_before.owner_user_id IS DISTINCT FROM target.owner_user_id
      OR lower(performer_before.handle) IS DISTINCT FROM target.handle
      OR performer_before.display_name IS DISTINCT FROM target.display_name
      OR performer_before.bio IS NOT NULL
      OR performer_before.is_active IS DISTINCT FROM false
      OR performer_before.visibility_state::text IS DISTINCT FROM 'draft'
      OR performer_before.onboarding_status::text IS DISTINCT FROM 'created'
    THEN
      RAISE EXCEPTION 'Friend profile publication: identity or draft state changed for %', target.handle;
    END IF;

    IF (SELECT count(*) FROM performers p WHERE lower(p.handle) = target.handle) <> 1
      OR NOT EXISTS (
        SELECT 1 FROM performer_handle_claims hc
        WHERE hc.normalized_handle = target.handle
          AND hc.performer_id = target.performer_id
          AND hc.claim_kind = 'canonical'
      )
    THEN
      RAISE EXCEPTION 'Friend profile publication: canonical handle mismatch for %', target.handle;
    END IF;

    SELECT pv.* INTO preview_source FROM performer_profile_previews pv
    WHERE pv.id = target.preview_id
    FOR SHARE;
    IF NOT FOUND
      OR preview_source.claimed_performer_id IS DISTINCT FROM target.performer_id
      OR lower(preview_source.handle) IS DISTINCT FROM target.handle
      OR preview_source.display_name IS DISTINCT FROM target.display_name
      OR preview_source.is_active IS DISTINCT FROM true
      OR preview_source.avatar_url IS DISTINCT FROM target.avatar_url
      OR preview_source.metadata IS DISTINCT FROM jsonb_build_object('stageName', target.display_name)
    THEN
      RAISE EXCEPTION 'Friend profile publication: curated preview identity or image changed for %', target.handle;
    END IF;

    IF EXISTS (
      SELECT 1 FROM active_blocks b
      WHERE b.status = 'active' AND b.revoked_at IS NULL
        AND b.scope = 'patron_user_id'
        AND b.normalized_value = target.owner_user_id::text
    ) OR EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (m.entity_type, m.entity_id) m.status
        FROM moderation_events m
        WHERE m.entity_id IN (target.performer_id, target.owner_user_id, target.preview_id)
        ORDER BY m.entity_type, m.entity_id, m.created_at DESC, m.id DESC
      ) latest_moderation
      WHERE latest_moderation.status <> 'allowed'
    ) THEN
      RAISE EXCEPTION 'Friend profile publication: moderation review required for %', target.handle;
    END IF;

    -- The reviewed baseline has no public profile, links, or prior owner save.
    -- Do not use an upsert: even a new empty profile is an intervening user edit.
    PERFORM 1 FROM performer_public_profiles pp
    WHERE pp.performer_id = target.performer_id FOR UPDATE;
    IF FOUND THEN
      RAISE EXCEPTION 'Friend profile publication: public profile already exists for %', target.handle;
    END IF;
    PERFORM 1 FROM performer_profile_links l
    WHERE l.performer_id = target.performer_id FOR UPDATE;
    IF FOUND OR EXISTS (
      SELECT 1 FROM audit_events a
      WHERE a.entity_type = 'performer' AND a.entity_id = target.performer_id
        AND a.event_type IN ('performer_public_profile.update', 'performer_visibility.update')
    ) THEN
      RAISE EXCEPTION 'Friend profile publication: prior profile or visibility edit for %', target.handle;
    END IF;

    before_snapshot := jsonb_build_object(
      'performer', jsonb_build_object(
        'bio', performer_before.bio,
        'is_active', performer_before.is_active,
        'visibility_state', performer_before.visibility_state,
        'updated_at', performer_before.updated_at
      ),
      'publicProfile', NULL,
      'links', '[]'::jsonb
    );
    applied_at := clock_timestamp();

    INSERT INTO performer_public_profiles (
      performer_id, headline, specialties, avatar_url, facebook_url, instagram_url,
      website_url, featured_media, metadata, created_at, updated_at
    ) VALUES (
      target.performer_id, target.headline, target.specialties, preview_source.avatar_url,
      target.facebook_url, target.instagram_url, target.website_url, '[]'::jsonb,
      jsonb_build_object(
        'stageName', target.display_name,
        'primaryRole', target.roles->>0,
        'roles', target.roles,
        'profileProvenance', jsonb_build_object(
          'migrationId', migration_key,
          'verifiedOn', '2026-09-08',
          'publicationAuthority', 'user_authorized_operator_publication',
          'avatarSource', 'existing_curated_public_preview',
          'sources', target.sources,
          'userConfirmedFacts', target.user_confirmed_facts
        )
      ),
      applied_at, applied_at
    ) RETURNING * INTO profile_after;

    INSERT INTO performer_profile_links (
      performer_id, label, description, url, kind, sort_order, is_active, created_at, updated_at
    )
    SELECT target.performer_id, item->>'label', item->>'description', item->>'url',
      item->>'kind', (ordinality - 1)::integer, true, applied_at, applied_at
    FROM jsonb_array_elements(target.links) WITH ORDINALITY AS reviewed_links(item, ordinality);

    UPDATE performers SET bio = target.bio, is_active = true,
      visibility_state = 'public', updated_at = applied_at
    WHERE id = target.performer_id;

    after_snapshot := jsonb_build_object(
      'performer', jsonb_build_object(
        'bio', target.bio, 'is_active', true, 'visibility_state', 'public', 'updated_at', applied_at
      ),
      'publicProfile', to_jsonb(profile_after),
      'links', (
        SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.sort_order, l.id), '[]'::jsonb)
        FROM performer_profile_links l WHERE l.performer_id = target.performer_id
      )
    );

    INSERT INTO audit_events (
      actor_type, actor_id, entity_type, entity_id, event_type,
      previous_status, next_status, metadata, created_at
    ) VALUES (
      'operator', NULL, 'performer', target.performer_id, publication_event,
      performer_before.visibility_state::text, 'public',
      jsonb_build_object(
        'migrationId', migration_key,
        'authority', 'User authorized public professional pages for these four friends.',
        'identity', jsonb_build_object(
          'performerId', target.performer_id, 'ownerUserId', target.owner_user_id,
          'previewId', target.preview_id, 'handle', target.handle
        ),
        'before', before_snapshot,
        'after', after_snapshot,
        'onboardingStatusUnchanged', performer_before.onboarding_status,
        'accountClaimPerformed', false,
        'messageSent', false
      ),
      applied_at
    );
  END LOOP;
END;
$friend_public_profiles$;
