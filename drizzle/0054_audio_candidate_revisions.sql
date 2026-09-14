CREATE TABLE "audio_candidate_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"source_asset_version_id" uuid NOT NULL,
	"file_access_grant_id" uuid NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"upload_session_id" uuid NOT NULL,
	"original_filename" text NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"provider_version_id" text,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"codec" text,
	"sample_rate_hz" integer,
	"bit_depth" integer,
	"channel_count" integer,
	"integrity_status" "audio_asset_integrity_status" NOT NULL,
	"integrity_verifier_key" text NOT NULL,
	"integrity_verified_at" timestamp with time zone NOT NULL,
	"integrity_evidence" jsonb NOT NULL,
	"intake_status" text DEFAULT 'private_review' NOT NULL,
	"original_preserved" boolean DEFAULT true NOT NULL,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_candidate_revisions_byte_size_valid" CHECK ("audio_candidate_revisions"."byte_size" > 0),
	CONSTRAINT "audio_candidate_revisions_sha_valid" CHECK ("audio_candidate_revisions"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audio_candidate_revisions_audio_required" CHECK ("audio_candidate_revisions"."mime_type" like 'audio/%'),
	CONSTRAINT "audio_candidate_revisions_duration_valid" CHECK ("audio_candidate_revisions"."duration_ms" > 0),
	CONSTRAINT "audio_candidate_revisions_audio_metadata_valid" CHECK (("audio_candidate_revisions"."sample_rate_hz" is null or "audio_candidate_revisions"."sample_rate_hz" > 0) and ("audio_candidate_revisions"."bit_depth" is null or "audio_candidate_revisions"."bit_depth" > 0) and ("audio_candidate_revisions"."channel_count" is null or "audio_candidate_revisions"."channel_count" > 0)),
	CONSTRAINT "audio_candidate_revisions_integrity_verified" CHECK ("audio_candidate_revisions"."integrity_status" = 'verified'),
	CONSTRAINT "audio_candidate_revisions_integrity_evidence_required" CHECK (jsonb_typeof("audio_candidate_revisions"."integrity_evidence") = 'object' and "audio_candidate_revisions"."integrity_evidence" <> '{}'::jsonb),
	CONSTRAINT "audio_candidate_revisions_private_review_only" CHECK ("audio_candidate_revisions"."intake_status" = 'private_review'),
	CONSTRAINT "audio_candidate_revisions_original_required" CHECK ("audio_candidate_revisions"."original_preserved" = true)
);
--> statement-breakpoint
DROP INDEX "audio_file_access_grants_active_connection_asset_grantee_idx";--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD COLUMN "grant_purpose" text DEFAULT 'review_share' NOT NULL;--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD COLUMN "idempotency_key_hash" text;--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD COLUMN "intent_fingerprint" text;--> statement-breakpoint
-- Legacy selected-file grants could carry can_upload_new_version=true without
-- the bounded, idempotent candidate intent introduced here. They must never be
-- reinterpreted as candidate authority. Revoke them and retain only an inert,
-- schema-valid review permission snapshot before the new coherence checks land.
ALTER TABLE "audio_file_access_grants" DISABLE TRIGGER "audio_file_access_grants_state";--> statement-breakpoint
UPDATE "audio_file_access_grants"
SET
  "can_stream_preview" = CASE
    WHEN "can_download_original" = false
      AND "can_comment" = false
      AND "can_approve" = false
    THEN true
    ELSE "can_stream_preview"
  END,
  "can_upload_new_version" = false,
  "revoked_at" = COALESCE("revoked_at", clock_timestamp()),
  "revoked_by_user_id" = COALESCE("revoked_by_user_id", "granted_by_user_id"),
  "revocation_reason" = COALESCE(
    "revocation_reason",
    'Revoked during Wave 5A migration: legacy upload authority lacked bounded candidate intent.'
  )
WHERE "can_upload_new_version" = true;--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ENABLE TRIGGER "audio_file_access_grants_state";--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD COLUMN "upload_purpose" text DEFAULT 'owner_asset' NOT NULL;--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD COLUMN "collaborator_file_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD COLUMN "source_asset_version_id" uuid;--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD COLUMN "request_fingerprint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_file_access_grants_id_project_grantee_idx" ON "audio_file_access_grants" USING btree ("id","project_id","grantee_user_id");--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."audio_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_asset_id_audio_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."audio_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_source_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "public"."audio_project_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_file_access_grant_id_audio_file_access_grants_id_fk" FOREIGN KEY ("file_access_grant_id") REFERENCES "public"."audio_file_access_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_upload_session_id_audio_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."audio_upload_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_project_performer_fk" FOREIGN KEY ("project_id","performer_id") REFERENCES "public"."audio_projects"("id","performer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_asset_project_fk" FOREIGN KEY ("asset_id","project_id") REFERENCES "public"."audio_assets"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_source_version_project_fk" FOREIGN KEY ("source_asset_version_id","project_id") REFERENCES "public"."audio_project_asset_versions"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_file_grant_scope_fk" FOREIGN KEY ("file_access_grant_id","project_id","uploaded_by_user_id") REFERENCES "public"."audio_file_access_grants"("id","project_id","grantee_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_upload_project_fk" FOREIGN KEY ("upload_session_id","project_id") REFERENCES "public"."audio_upload_sessions"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_candidate_revisions" ADD CONSTRAINT "audio_candidate_revisions_upload_identity_fk" FOREIGN KEY ("upload_session_id","sha256","byte_size") REFERENCES "public"."audio_upload_sessions"("id","expected_sha256","expected_byte_size") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_candidate_revisions_grant_idx" ON "audio_candidate_revisions" USING btree ("file_access_grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_candidate_revisions_upload_session_idx" ON "audio_candidate_revisions" USING btree ("upload_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_candidate_revisions_storage_object_idx" ON "audio_candidate_revisions" USING btree ("storage_provider","storage_bucket","storage_key");--> statement-breakpoint
CREATE INDEX "audio_candidate_revisions_project_created_idx" ON "audio_candidate_revisions" USING btree ("project_id","created_at");--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD CONSTRAINT "audio_upload_sessions_collaborator_file_grant_id_audio_file_access_grants_id_fk" FOREIGN KEY ("collaborator_file_grant_id") REFERENCES "public"."audio_file_access_grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD CONSTRAINT "audio_upload_sessions_source_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "public"."audio_project_asset_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD CONSTRAINT "audio_upload_sessions_collaborator_grant_scope_fk" FOREIGN KEY ("collaborator_file_grant_id","project_id","initiated_by_user_id") REFERENCES "public"."audio_file_access_grants"("id","project_id","grantee_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD CONSTRAINT "audio_upload_sessions_source_version_project_fk" FOREIGN KEY ("source_asset_version_id","project_id") REFERENCES "public"."audio_project_asset_versions"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_file_access_grants_grantor_idempotency_idx" ON "audio_file_access_grants" USING btree ("granted_by_user_id","idempotency_key_hash") WHERE "audio_file_access_grants"."idempotency_key_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_upload_sessions_collaborator_grant_idx" ON "audio_upload_sessions" USING btree ("collaborator_file_grant_id") WHERE "audio_upload_sessions"."collaborator_file_grant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_file_access_grants_active_connection_asset_grantee_idx" ON "audio_file_access_grants" USING btree ("connection_id","asset_version_id","grantee_user_id","grant_purpose") WHERE "audio_file_access_grants"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD CONSTRAINT "audio_file_access_grants_purpose_allowed" CHECK ("audio_file_access_grants"."grant_purpose" in ('review_share', 'collaborator_revision_upload'));--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD CONSTRAINT "audio_file_access_grants_purpose_permissions_coherent" CHECK (("audio_file_access_grants"."grant_purpose" = 'review_share' and "audio_file_access_grants"."can_upload_new_version" = false) or ("audio_file_access_grants"."grant_purpose" = 'collaborator_revision_upload' and "audio_file_access_grants"."can_upload_new_version" = true and "audio_file_access_grants"."can_stream_preview" = false and "audio_file_access_grants"."can_download_original" = false and "audio_file_access_grants"."can_comment" = false and "audio_file_access_grants"."can_approve" = false));--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD CONSTRAINT "audio_file_access_grants_purpose_intent_coherent" CHECK (("audio_file_access_grants"."grant_purpose" = 'review_share' and "audio_file_access_grants"."idempotency_key_hash" is null and "audio_file_access_grants"."intent_fingerprint" is null) or ("audio_file_access_grants"."grant_purpose" = 'collaborator_revision_upload' and "audio_file_access_grants"."idempotency_key_hash" ~ '^[0-9a-f]{64}$' and "audio_file_access_grants"."intent_fingerprint" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD CONSTRAINT "audio_file_access_grants_collaborator_expiry_bounded" CHECK ("audio_file_access_grants"."grant_purpose" <> 'collaborator_revision_upload' or ("audio_file_access_grants"."expires_at" is not null and "audio_file_access_grants"."expires_at" <= "audio_file_access_grants"."created_at" + interval '7 days'));--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD CONSTRAINT "audio_upload_sessions_purpose_allowed" CHECK ("audio_upload_sessions"."upload_purpose" in ('owner_asset', 'collaborator_revision'));--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD CONSTRAINT "audio_upload_sessions_collaborator_purpose_coherent" CHECK (("audio_upload_sessions"."upload_purpose" = 'owner_asset' and "audio_upload_sessions"."collaborator_file_grant_id" is null and "audio_upload_sessions"."source_asset_version_id" is null and "audio_upload_sessions"."request_fingerprint" is null) or ("audio_upload_sessions"."upload_purpose" = 'collaborator_revision' and "audio_upload_sessions"."collaborator_file_grant_id" is not null and "audio_upload_sessions"."source_asset_version_id" is not null and "audio_upload_sessions"."request_fingerprint" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
CREATE FUNCTION "sway_require_active_collaborator_revision_grant"(
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
  subject_connection_id uuid;
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

  SELECT connection_id INTO subject_connection_id
  FROM audio_file_access_grants
  WHERE id = p_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Collaborator revision upload requires an active exact-file upload grant.';
  END IF;
  PERFORM 1
  FROM audio_file_connections connection
  WHERE connection.id = subject_connection_id
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

  IF NOT EXISTS (
    SELECT 1 FROM audio_file_connections connection
    WHERE connection.id = grant_record.connection_id
      AND connection.member_one_user_id = grant_record.connection_member_one_user_id
      AND connection.member_two_user_id = grant_record.connection_member_two_user_id
      AND connection.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Collaborator revision upload requires an active file connection.';
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
CREATE OR REPLACE FUNCTION "sway_enforce_audio_upload_session_state"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.upload_status <> 'initiated' OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Audio upload sessions must begin in initiated state.';
    END IF;
    IF NEW.upload_purpose = 'owner_asset' THEN
      IF NOT EXISTS (
        SELECT 1 FROM audio_project_access_grants authority
        WHERE authority.project_id = NEW.project_id
          AND authority.grantee_user_id = NEW.initiated_by_user_id
          AND authority.can_upload_versions = true
          AND authority.revoked_at IS NULL
          AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
      ) THEN
        RAISE EXCEPTION 'Audio upload sessions require active upload authority for the project.';
      END IF;
    ELSE
      IF NEW.asset_id IS NULL
        OR NEW.source_asset_version_id IS NULL
        OR NEW.expected_mime_type NOT LIKE 'audio/%' THEN
        RAISE EXCEPTION 'Collaborator revisions require an exact existing audio source.';
      END IF;
      PERFORM sway_require_active_collaborator_revision_grant(
        NEW.collaborator_file_grant_id,
        NEW.project_id,
        NEW.initiated_by_user_id,
        NEW.asset_id,
        NEW.source_asset_version_id
      );
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id
    OR NEW.upload_purpose IS DISTINCT FROM OLD.upload_purpose
    OR NEW.collaborator_file_grant_id IS DISTINCT FROM OLD.collaborator_file_grant_id
    OR NEW.source_asset_version_id IS DISTINCT FROM OLD.source_asset_version_id
    OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
    OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
    OR NEW.provider_upload_id IS DISTINCT FROM OLD.provider_upload_id
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
    OR NEW.expected_mime_type IS DISTINCT FROM OLD.expected_mime_type
    OR NEW.expected_byte_size IS DISTINCT FROM OLD.expected_byte_size
    OR NEW.expected_sha256 IS DISTINCT FROM OLD.expected_sha256
    OR NEW.part_size_bytes IS DISTINCT FROM OLD.part_size_bytes
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'Audio upload session identity is immutable.';
  END IF;

  IF OLD.upload_status IN ('completed', 'rejected', 'aborted', 'expired') THEN
    RAISE EXCEPTION 'Terminal audio upload sessions cannot change state.';
  END IF;
  IF NEW.upload_status <> OLD.upload_status AND NOT (
    (OLD.upload_status = 'initiated' AND NEW.upload_status IN ('uploading', 'aborted', 'expired')) OR
    (OLD.upload_status = 'uploading' AND NEW.upload_status IN ('uploaded', 'aborted', 'expired')) OR
    (OLD.upload_status = 'uploaded' AND NEW.upload_status IN ('verifying', 'aborted', 'expired')) OR
    (OLD.upload_status = 'verifying' AND NEW.upload_status IN ('completed', 'quarantined', 'rejected', 'aborted')) OR
    (OLD.upload_status = 'quarantined' AND NEW.upload_status IN ('verifying', 'rejected', 'aborted'))
  ) THEN
    RAISE EXCEPTION 'Invalid audio upload transition from % to %.', OLD.upload_status, NEW.upload_status;
  END IF;
  IF NEW.upload_status = 'completed' AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'Completed audio upload sessions require completed_at.';
  END IF;
  IF NEW.upload_status <> 'completed' AND NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Only completed audio upload sessions may set completed_at.';
  END IF;
  IF NEW.upload_purpose = 'collaborator_revision'
    AND NEW.upload_status IN ('uploading', 'uploaded', 'verifying', 'completed') THEN
    IF NEW.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'Collaborator revision upload session expired.';
    END IF;
    PERFORM sway_require_active_collaborator_revision_grant(
      NEW.collaborator_file_grant_id,
      NEW.project_id,
      NEW.initiated_by_user_id,
      NEW.asset_id,
      NEW.source_asset_version_id
    );
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sway_validate_audio_file_access_grant"() RETURNS trigger AS $$
DECLARE
  selected_version audio_project_asset_versions%ROWTYPE;
  subject_performer_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audio_file_connections connection
    WHERE connection.id = NEW.connection_id
      AND connection.member_one_user_id = NEW.connection_member_one_user_id
      AND connection.member_two_user_id = NEW.connection_member_two_user_id
      AND connection.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Selected-file access requires an active file connection.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audio_project_access_grants authority
    WHERE authority.id = NEW.grantor_project_access_grant_id
      AND authority.project_id = NEW.project_id
      AND authority.grantee_user_id = NEW.granted_by_user_id
      AND authority.can_manage_access = true
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Selected-file access requires active project access-management authority.';
  END IF;

  SELECT * INTO selected_version
  FROM audio_project_asset_versions version
  WHERE version.id = NEW.asset_version_id
    AND version.project_id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Selected-file access requires an existing project version.';
  END IF;
  SELECT performer_id INTO subject_performer_id
  FROM audio_projects
  WHERE id = NEW.project_id;
  IF NEW.grant_purpose = 'collaborator_revision_upload' THEN
    IF selected_version.integrity_status <> 'verified'
      OR selected_version.mime_type NOT LIKE 'audio/%'
      OR NEW.expires_at IS NULL
      OR NEW.expires_at <= clock_timestamp() THEN
      RAISE EXCEPTION 'Collaborator revision grants require a current verified audio file and future expiry.';
    END IF;
    PERFORM sway_require_current_performer_capability(
      subject_performer_id,
      'private_collaboration'::performer_capability
    );
  END IF;

  RETURN NEW;
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
CREATE FUNCTION "sway_reject_candidate_session_asset_version"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM audio_upload_sessions session
    WHERE session.id = NEW.upload_session_id
      AND session.upload_purpose = 'collaborator_revision'
  ) THEN
    RAISE EXCEPTION 'Collaborator revision sessions cannot seal ordinary project versions.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE FUNCTION "sway_validate_audio_candidate_revision"() RETURNS trigger AS $$
DECLARE
  upload_record audio_upload_sessions%ROWTYPE;
BEGIN
  PERFORM sway_require_active_collaborator_revision_grant(
    NEW.file_access_grant_id,
    NEW.project_id,
    NEW.uploaded_by_user_id,
    NEW.asset_id,
    NEW.source_asset_version_id
  );

  SELECT * INTO upload_record
  FROM audio_upload_sessions
  WHERE id = NEW.upload_session_id
  FOR UPDATE;

  IF NOT FOUND
    OR upload_record.upload_purpose <> 'collaborator_revision'
    OR upload_record.upload_status <> 'completed'
    OR upload_record.completed_at IS NULL
    OR upload_record.expires_at <= clock_timestamp()
    OR upload_record.project_id <> NEW.project_id
    OR upload_record.asset_id IS DISTINCT FROM NEW.asset_id
    OR upload_record.source_asset_version_id IS DISTINCT FROM NEW.source_asset_version_id
    OR upload_record.collaborator_file_grant_id IS DISTINCT FROM NEW.file_access_grant_id
    OR upload_record.initiated_by_user_id <> NEW.uploaded_by_user_id
    OR upload_record.storage_provider <> NEW.storage_provider
    OR upload_record.storage_bucket <> NEW.storage_bucket
    OR upload_record.storage_key <> NEW.storage_key
    OR upload_record.original_filename <> NEW.original_filename
    OR upload_record.expected_mime_type <> NEW.mime_type
    OR upload_record.expected_byte_size <> NEW.byte_size
    OR upload_record.expected_sha256 <> NEW.sha256 THEN
    RAISE EXCEPTION 'Private candidate identity must match one completed collaborator upload session.';
  END IF;
  IF NEW.integrity_status <> 'verified'
    OR NEW.integrity_verified_at < upload_record.completed_at
    OR jsonb_typeof(NEW.integrity_evidence) <> 'object'
    OR NEW.integrity_evidence = '{}'::jsonb
    OR NEW.intake_status <> 'private_review' THEN
    RAISE EXCEPTION 'Private candidates require post-upload technical verification evidence.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "audio_project_asset_versions_00_no_candidate_session"
BEFORE INSERT ON "audio_project_asset_versions"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_candidate_session_asset_version"();--> statement-breakpoint
CREATE TRIGGER "audio_candidate_revisions_validate"
BEFORE INSERT ON "audio_candidate_revisions"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_audio_candidate_revision"();--> statement-breakpoint
CREATE TRIGGER "audio_candidate_revisions_append_only"
BEFORE UPDATE OR DELETE ON "audio_candidate_revisions"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
