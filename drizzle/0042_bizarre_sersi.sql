DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM audio_object_cleanup_receipts receipt
    LEFT JOIN audio_upload_sessions session
      ON session.id = receipt.upload_session_id
      AND session.project_id = receipt.project_id
      AND session.storage_provider = receipt.storage_provider
      AND session.storage_bucket = receipt.storage_bucket
      AND session.storage_key = receipt.storage_key
      AND session.provider_upload_id = receipt.provider_upload_id
    WHERE (
      receipt.cleanup_reason IN ('orphaned_owner_initiation', 'orphaned_candidate_initiation')
      AND receipt.upload_session_id IS NOT NULL
    ) OR (
      receipt.cleanup_reason IN ('owner_integrity_validation_failed', 'candidate_technical_validation_failed')
      AND receipt.upload_session_id IS NULL
    ) OR (
      receipt.upload_session_id IS NOT NULL
      AND (
        receipt.provider_upload_id IS NULL
        OR session.id IS NULL
        OR EXISTS (
          SELECT 1
          FROM audio_candidate_revisions candidate
          WHERE candidate.upload_session_id = receipt.upload_session_id
        )
        OR EXISTS (
          SELECT 1
          FROM audio_project_asset_versions version
          WHERE version.upload_session_id = receipt.upload_session_id
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'Wave 5A cleanup receipt preflight failed: repair invalid or sealed session bindings before migration 0042.';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" DROP CONSTRAINT "audio_file_access_grants_purpose_intent_coherent";--> statement-breakpoint
ALTER TABLE "audio_object_cleanup_receipts" DROP CONSTRAINT "audio_object_cleanup_receipts_reason_allowed";--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD COLUMN "max_candidate_bytes" bigint;--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" DISABLE TRIGGER "audio_file_access_grants_state";--> statement-breakpoint
UPDATE "audio_file_access_grants"
SET
  "max_candidate_bytes" = 536870912,
  "revoked_at" = COALESCE("revoked_at", clock_timestamp()),
  "revoked_by_user_id" = COALESCE("revoked_by_user_id", "granted_by_user_id"),
  "revocation_reason" = COALESCE(
    "revocation_reason",
    'Revoked during Wave 5A migration: creator-approved candidate byte ceiling was not recorded.'
  )
WHERE "grant_purpose" = 'collaborator_revision_upload';--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ENABLE TRIGGER "audio_file_access_grants_state";--> statement-breakpoint
ALTER TABLE "audio_object_cleanup_receipts" ADD CONSTRAINT "audio_object_cleanup_receipts_upload_session_id_audio_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."audio_upload_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_upload_sessions_id_storage_object_idx" ON "audio_upload_sessions" USING btree ("id","storage_provider","storage_bucket","storage_key","provider_upload_id");--> statement-breakpoint
ALTER TABLE "audio_object_cleanup_receipts" ADD CONSTRAINT "audio_object_cleanup_receipts_upload_session_object_fk" FOREIGN KEY ("upload_session_id","storage_provider","storage_bucket","storage_key","provider_upload_id") REFERENCES "public"."audio_upload_sessions"("id","storage_provider","storage_bucket","storage_key","provider_upload_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD CONSTRAINT "audio_file_access_grants_purpose_intent_coherent" CHECK (("audio_file_access_grants"."grant_purpose" = 'review_share' and "audio_file_access_grants"."idempotency_key_hash" is null and "audio_file_access_grants"."intent_fingerprint" is null and "audio_file_access_grants"."max_candidate_bytes" is null) or ("audio_file_access_grants"."grant_purpose" = 'collaborator_revision_upload' and "audio_file_access_grants"."idempotency_key_hash" ~ '^[0-9a-f]{64}$' and "audio_file_access_grants"."intent_fingerprint" ~ '^[0-9a-f]{64}$' and "audio_file_access_grants"."max_candidate_bytes" between 1 and 536870912));--> statement-breakpoint
ALTER TABLE "audio_object_cleanup_receipts" ADD CONSTRAINT "audio_object_cleanup_receipts_reason_session_coherent" CHECK (("audio_object_cleanup_receipts"."cleanup_reason" in ('orphaned_owner_initiation', 'orphaned_candidate_initiation') and "audio_object_cleanup_receipts"."upload_session_id" is null) or ("audio_object_cleanup_receipts"."cleanup_reason" in ('owner_integrity_validation_failed', 'candidate_technical_validation_failed', 'candidate_grant_revoked', 'candidate_connection_revoked') and "audio_object_cleanup_receipts"."upload_session_id" is not null));--> statement-breakpoint
ALTER TABLE "audio_object_cleanup_receipts" ADD CONSTRAINT "audio_object_cleanup_receipts_session_identity_complete" CHECK ("audio_object_cleanup_receipts"."upload_session_id" is null or "audio_object_cleanup_receipts"."provider_upload_id" is not null);--> statement-breakpoint
ALTER TABLE "audio_object_cleanup_receipts" ADD CONSTRAINT "audio_object_cleanup_receipts_reason_allowed" CHECK ("audio_object_cleanup_receipts"."cleanup_reason" in ('orphaned_owner_initiation', 'orphaned_candidate_initiation', 'owner_integrity_validation_failed', 'candidate_technical_validation_failed', 'candidate_grant_revoked', 'candidate_connection_revoked'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sway_require_active_collaborator_revision_grant"(
  p_grant_id uuid,
  p_expected_project_id uuid,
  p_expected_grantee_user_id uuid,
  p_expected_asset_id uuid,
  p_expected_source_version_id uuid
) RETURNS void AS $$
DECLARE
  grant_record audio_file_access_grants%ROWTYPE;
  base_version audio_project_asset_versions%ROWTYPE;
  subject_performer_id uuid;
BEGIN
  SELECT performer_id INTO subject_performer_id
  FROM audio_projects
  WHERE id = p_expected_project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collaborator revision upload requires an existing audio project.';
  END IF;
  PERFORM sway_require_current_performer_capability(
    subject_performer_id,
    'private_collaboration'::performer_capability
  );

  SELECT * INTO grant_record
  FROM audio_file_access_grants
  WHERE id = p_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collaborator revision upload requires an active exact-file upload grant.';
  END IF;

  PERFORM 1
  FROM audio_project_access_grants authority
  WHERE authority.id = grant_record.grantor_project_access_grant_id
    AND authority.project_id = p_expected_project_id
    AND authority.grantee_user_id = grant_record.granted_by_user_id
    AND authority.can_manage_access = true
    AND authority.revoked_at IS NULL
    AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collaborator revision upload requires the issuing project authority to remain active.';
  END IF;

  PERFORM 1
  FROM audio_file_connections connection
  WHERE connection.id = grant_record.connection_id
    AND connection.revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collaborator revision upload requires an active file connection.';
  END IF;

  SELECT * INTO grant_record
  FROM audio_file_access_grants
  WHERE id = p_grant_id
  FOR UPDATE;
  IF NOT FOUND
    OR grant_record.project_id <> p_expected_project_id
    OR grant_record.grantee_user_id <> p_expected_grantee_user_id
    OR grant_record.asset_version_id <> p_expected_source_version_id
    OR grant_record.grant_purpose <> 'collaborator_revision_upload'
    OR grant_record.max_candidate_bytes IS NULL
    OR grant_record.max_candidate_bytes < 1
    OR grant_record.max_candidate_bytes > 536870912
    OR grant_record.can_upload_new_version <> true
    OR grant_record.can_stream_preview <> false
    OR grant_record.can_download_original <> false
    OR grant_record.can_comment <> false
    OR grant_record.can_approve <> false
    OR grant_record.revoked_at IS NOT NULL
    OR grant_record.expires_at IS NULL
    OR grant_record.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Collaborator revision upload requires an active exact-file upload grant.';
  END IF;

  SELECT * INTO base_version
  FROM audio_project_asset_versions
  WHERE id = p_expected_source_version_id;
  IF NOT FOUND
    OR base_version.project_id <> p_expected_project_id
    OR base_version.asset_id <> p_expected_asset_id
    OR base_version.integrity_status <> 'verified'
    OR base_version.mime_type NOT LIKE 'audio/%' THEN
    RAISE EXCEPTION 'Collaborator revision upload must target the exact selected working audio file.';
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sway_enforce_audio_file_access_grant_state"() RETURNS trigger AS $$
BEGIN
  IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
    OR NEW.connection_member_one_user_id IS DISTINCT FROM OLD.connection_member_one_user_id
    OR NEW.connection_member_two_user_id IS DISTINCT FROM OLD.connection_member_two_user_id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.asset_version_id IS DISTINCT FROM OLD.asset_version_id
    OR NEW.grantor_project_access_grant_id IS DISTINCT FROM OLD.grantor_project_access_grant_id
    OR NEW.grantor_can_manage_access IS DISTINCT FROM OLD.grantor_can_manage_access
    OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
    OR NEW.grantee_user_id IS DISTINCT FROM OLD.grantee_user_id
    OR NEW.grant_purpose IS DISTINCT FROM OLD.grant_purpose
    OR NEW.idempotency_key_hash IS DISTINCT FROM OLD.idempotency_key_hash
    OR NEW.intent_fingerprint IS DISTINCT FROM OLD.intent_fingerprint
    OR NEW.max_candidate_bytes IS DISTINCT FROM OLD.max_candidate_bytes
    OR NEW.can_stream_preview IS DISTINCT FROM OLD.can_stream_preview
    OR NEW.can_download_original IS DISTINCT FROM OLD.can_download_original
    OR NEW.can_upload_new_version IS DISTINCT FROM OLD.can_upload_new_version
    OR NEW.can_comment IS DISTINCT FROM OLD.can_comment
    OR NEW.can_approve IS DISTINCT FROM OLD.can_approve
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Selected-file access grant scope is immutable.';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Revoked selected-file access grants cannot be restored or changed.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE FUNCTION "sway_validate_candidate_upload_byte_ceiling"() RETURNS trigger AS $$
BEGIN
  IF NEW.upload_purpose = 'collaborator_revision' AND NOT EXISTS (
    SELECT 1
    FROM audio_file_access_grants grant_record
    WHERE grant_record.id = NEW.collaborator_file_grant_id
      AND grant_record.max_candidate_bytes IS NOT NULL
      AND NEW.expected_byte_size <= grant_record.max_candidate_bytes
  ) THEN
    RAISE EXCEPTION 'Private candidate exceeds the creator-approved byte ceiling.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "audio_upload_sessions_00_candidate_byte_ceiling"
BEFORE INSERT ON "audio_upload_sessions"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_candidate_upload_byte_ceiling"();--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_cleanup_receipt_state"() RETURNS trigger AS $$
DECLARE
  session_record audio_upload_sessions%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Audio object cleanup receipts are append-only evidence.';
  END IF;

  IF TG_OP = 'INSERT'
    AND (
      NEW.cleanup_status <> 'pending'
      OR NEW.attempt_count <> 1
      OR NEW.completed_at IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'Audio object cleanup receipts must begin pending at attempt one.';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.project_id IS DISTINCT FROM OLD.project_id
      OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
      OR NEW.upload_session_id IS DISTINCT FROM OLD.upload_session_id
      OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
      OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
      OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
      OR NEW.provider_upload_id IS DISTINCT FROM OLD.provider_upload_id
      OR NEW.cleanup_reason IS DISTINCT FROM OLD.cleanup_reason
      OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
      RAISE EXCEPTION 'Audio object cleanup receipt target identity is immutable.';
    END IF;
    IF OLD.cleanup_status = 'completed' THEN
      RAISE EXCEPTION 'Completed audio object cleanup receipts are terminal.';
    END IF;
    IF NEW.cleanup_status <> OLD.cleanup_status
      AND NOT (OLD.cleanup_status = 'pending' AND NEW.cleanup_status = 'completed') THEN
      RAISE EXCEPTION 'Audio object cleanup receipt state transition is invalid.';
    END IF;
    IF NEW.attempt_count < OLD.attempt_count
      OR NEW.last_attempt_at < OLD.last_attempt_at THEN
      RAISE EXCEPTION 'Audio object cleanup attempt evidence cannot move backwards.';
    END IF;
  END IF;

  IF NEW.upload_session_id IS NOT NULL THEN
    SELECT * INTO session_record
    FROM audio_upload_sessions
    WHERE id = NEW.upload_session_id
    FOR UPDATE;
    IF NOT FOUND
      OR session_record.project_id IS DISTINCT FROM NEW.project_id
      OR session_record.storage_provider IS DISTINCT FROM NEW.storage_provider
      OR session_record.storage_bucket IS DISTINCT FROM NEW.storage_bucket
      OR session_record.storage_key IS DISTINCT FROM NEW.storage_key
      OR session_record.provider_upload_id IS DISTINCT FROM NEW.provider_upload_id THEN
      RAISE EXCEPTION 'Session-backed cleanup receipt must match the exact upload object identity.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM audio_candidate_revisions candidate
      WHERE candidate.upload_session_id = NEW.upload_session_id
    ) OR EXISTS (
      SELECT 1 FROM audio_project_asset_versions version
      WHERE version.upload_session_id = NEW.upload_session_id
    ) THEN
      RAISE EXCEPTION 'Cleanup receipts cannot target a sealed preserved upload session.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "audio_object_cleanup_receipts_state"
BEFORE INSERT OR UPDATE OR DELETE ON "audio_object_cleanup_receipts"
FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_cleanup_receipt_state"();
