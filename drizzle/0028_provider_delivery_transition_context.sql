CREATE OR REPLACE FUNCTION "sway_record_distribution_delivery_transition"() RETURNS trigger AS $$
DECLARE
  actor_setting text;
  reason_setting text;
  idempotency_setting text;
  payload_setting text;
  provider_verified_setting text;
  provider_key_setting text;
  previous_guard text;
  evidence_changed boolean;
BEGIN
  previous_guard := current_setting('sway.delivery_transition_in_progress', true);
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.release_id IS DISTINCT FROM OLD.release_id
    OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
    OR NEW.destination_key IS DISTINCT FROM OLD.destination_key
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Distribution delivery identity is immutable.';
  END IF;

  IF NEW.delivery_status = OLD.delivery_status THEN
    IF NEW.provider_release_id IS DISTINCT FROM OLD.provider_release_id
      OR NEW.destination_release_id IS DISTINCT FROM OLD.destination_release_id
      OR NEW.metadata_fingerprint IS DISTINCT FROM OLD.metadata_fingerprint
      OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
      OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
      OR NEW.live_at IS DISTINCT FROM OLD.live_at
      OR NEW.takedown_requested_at IS DISTINCT FROM OLD.takedown_requested_at
      OR NEW.taken_down_at IS DISTINCT FROM OLD.taken_down_at
      OR NEW.last_error IS DISTINCT FROM OLD.last_error
      OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
      RAISE EXCEPTION 'Distribution delivery evidence may change only with an audited status transition.';
    END IF;
    NEW.updated_at := OLD.updated_at;
    RETURN NEW;
  END IF;

  IF NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
    OR NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
    OR NEW.live_at IS DISTINCT FROM OLD.live_at
    OR NEW.takedown_requested_at IS DISTINCT FROM OLD.takedown_requested_at
    OR NEW.taken_down_at IS DISTINCT FROM OLD.taken_down_at THEN
    RAISE EXCEPTION 'Distribution delivery milestones are assigned only by the transition trigger.';
  END IF;

  IF NOT (
    (OLD.delivery_status = 'draft' AND NEW.delivery_status IN ('queued', 'failed')) OR
    (OLD.delivery_status = 'queued' AND NEW.delivery_status IN ('submitted', 'failed')) OR
    (OLD.delivery_status = 'submitted' AND NEW.delivery_status IN ('accepted', 'correction_pending', 'failed')) OR
    (OLD.delivery_status = 'accepted' AND NEW.delivery_status IN ('live', 'correction_pending', 'takedown_requested', 'failed')) OR
    (OLD.delivery_status = 'live' AND NEW.delivery_status IN ('correction_pending', 'takedown_requested')) OR
    (OLD.delivery_status = 'correction_pending' AND NEW.delivery_status = 'failed') OR
    (OLD.delivery_status = 'takedown_requested' AND NEW.delivery_status IN ('taken_down', 'failed')) OR
    (OLD.delivery_status = 'failed' AND NEW.delivery_status IN ('queued', 'correction_pending'))
  ) THEN
    RAISE EXCEPTION 'Invalid distribution delivery transition from % to %.', OLD.delivery_status, NEW.delivery_status;
  END IF;

  actor_setting := nullif(current_setting('sway.actor_user_id', true), '');
  reason_setting := nullif(current_setting('sway.delivery_transition_reason', true), '');
  idempotency_setting := nullif(current_setting('sway.delivery_transition_idempotency_key', true), '');
  payload_setting := nullif(current_setting('sway.delivery_transition_payload_sha256', true), '');
  provider_verified_setting := nullif(current_setting('sway.provider_webhook_verified', true), '');
  provider_key_setting := nullif(current_setting('sway.provider_webhook_provider_key', true), '');
  IF actor_setting IS NULL OR reason_setting IS NULL OR idempotency_setting IS NULL THEN
    RAISE EXCEPTION 'Distribution delivery transitions require actor, reason, and idempotency context.';
  END IF;
  IF payload_setting IS NOT NULL AND payload_setting !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Distribution delivery payload fingerprint must be SHA-256 when provided.';
  END IF;
  evidence_changed := NEW.provider_release_id IS DISTINCT FROM OLD.provider_release_id
    OR NEW.destination_release_id IS DISTINCT FROM OLD.destination_release_id
    OR NEW.metadata_fingerprint IS DISTINCT FROM OLD.metadata_fingerprint
    OR NEW.last_error IS DISTINCT FROM OLD.last_error
    OR NEW.metadata IS DISTINCT FROM OLD.metadata;
  IF evidence_changed AND payload_setting IS NULL THEN
    RAISE EXCEPTION 'Distribution delivery evidence changes require a payload fingerprint.';
  END IF;
  IF NEW.delivery_status = 'failed' AND COALESCE(length(trim(NEW.last_error)), 0) = 0 THEN
    RAISE EXCEPTION 'Failed distribution deliveries require a recorded error.';
  END IF;
  IF NEW.delivery_status = 'submitted' AND (
    COALESCE(length(trim(NEW.provider_release_id)), 0) = 0
    OR NEW.metadata_fingerprint IS NULL
    OR payload_setting IS NULL
  ) THEN
    RAISE EXCEPTION 'Submitted distribution deliveries require a provider release ID, metadata fingerprint, and payload fingerprint.';
  END IF;
  IF NEW.delivery_status IN ('accepted', 'live') AND (
    COALESCE(length(trim(NEW.provider_release_id)), 0) = 0
    OR COALESCE(length(trim(NEW.destination_release_id)), 0) = 0
    OR NEW.metadata_fingerprint IS NULL
    OR payload_setting IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM music_distribution_delivery_events provider_event
      WHERE provider_event.delivery_id = NEW.id
        AND provider_event.event_type = 'provider_webhook'
        AND provider_event.payload_sha256 = payload_setting
    )
  ) THEN
    RAISE EXCEPTION 'Accepted and live deliveries require immutable provider callback evidence for the exact payload fingerprint.';
  END IF;

  IF NOT COALESCE((
    provider_verified_setting = 'true'
    AND provider_key_setting = NEW.provider_key
  ), false) AND NOT EXISTS (
    SELECT 1
    FROM music_releases release
    JOIN audio_project_access_grants authority ON authority.project_id = release.project_id
    WHERE release.id = NEW.release_id
      AND authority.grantee_user_id = actor_setting::uuid
      AND authority.can_manage_release = true
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Distribution delivery transitions require active release-management authority or verified provider context.';
  END IF;

  IF NEW.delivery_status = 'submitted' AND OLD.submitted_at IS NULL THEN NEW.submitted_at := clock_timestamp(); END IF;
  IF NEW.delivery_status = 'accepted' AND OLD.accepted_at IS NULL THEN NEW.accepted_at := clock_timestamp(); END IF;
  IF NEW.delivery_status = 'live' AND OLD.live_at IS NULL THEN NEW.live_at := clock_timestamp(); END IF;
  IF NEW.delivery_status = 'takedown_requested' AND OLD.takedown_requested_at IS NULL THEN NEW.takedown_requested_at := clock_timestamp(); END IF;
  IF NEW.delivery_status = 'taken_down' AND OLD.taken_down_at IS NULL THEN NEW.taken_down_at := clock_timestamp(); END IF;

  NEW.updated_at := clock_timestamp();
  PERFORM set_config('sway.delivery_transition_in_progress', NEW.id::text, true);
  INSERT INTO music_distribution_delivery_events (
    delivery_id, actor_user_id, event_type, idempotency_key, previous_status,
    next_status, payload_sha256, metadata
  ) VALUES (
    NEW.id, actor_setting::uuid, 'status_changed', idempotency_setting,
    OLD.delivery_status, NEW.delivery_status, payload_setting,
    jsonb_strip_nulls(jsonb_build_object(
      'reason', reason_setting,
      'providerReleaseId', NEW.provider_release_id,
      'destinationReleaseId', NEW.destination_release_id,
      'metadataFingerprint', NEW.metadata_fingerprint,
      'lastError', NEW.last_error
    ))
  );
  PERFORM set_config('sway.delivery_transition_in_progress', COALESCE(previous_guard, ''), true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('sway.delivery_transition_in_progress', COALESCE(previous_guard, ''), true);
  RAISE;
END;
$$ LANGUAGE plpgsql;
