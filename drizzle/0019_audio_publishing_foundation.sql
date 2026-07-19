CREATE TYPE "public"."audio_project_kind" AS ENUM('music', 'comedy', 'podcast', 'other_audio');
--> statement-breakpoint
CREATE TYPE "public"."audio_asset_integrity_status" AS ENUM('pending', 'verified', 'quarantined', 'rejected');
--> statement-breakpoint
CREATE TYPE "public"."audio_file_pairing_purpose" AS ENUM('request_files', 'send_files');
--> statement-breakpoint
CREATE TYPE "public"."music_distribution_mode" AS ENUM('private', 'sway_only', 'sway_first', 'everywhere');
--> statement-breakpoint
CREATE TYPE "public"."music_release_status" AS ENUM('draft', 'rights_review', 'ready', 'scheduled', 'published', 'takedown_requested', 'taken_down', 'blocked');
--> statement-breakpoint
CREATE TYPE "public"."catalog_transfer_status" AS ENUM(
  'intake', 'source_snapshot', 'rights_review', 'artist_identity_mapped', 'parity_locked',
  'new_delivery_staged', 'store_processing', 'overlap_live', 'store_match_verified',
  'artist_cutover_approved', 'old_provider_takedown', 'cutover_monitoring',
  'tail_royalty_reconciliation', 'complete', 'rights_blocked', 'parity_failed',
  'mapping_failed', 'track_link_failed', 'content_id_conflict', 'revenue_gap', 'canceled'
);
--> statement-breakpoint
CREATE TABLE "audio_projects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "title" text NOT NULL,
  "project_kind" "audio_project_kind" DEFAULT 'music' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_projects_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "performers"("id"),
  CONSTRAINT "audio_projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_projects_status_allowed" CHECK ("status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE INDEX "audio_projects_performer_status_idx" ON "audio_projects" ("performer_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_projects_id_performer_idx" ON "audio_projects" ("id", "performer_id");
--> statement-breakpoint
CREATE TABLE "audio_project_access_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "grantee_user_id" uuid NOT NULL,
  "role" text NOT NULL,
  "can_upload_versions" boolean DEFAULT false NOT NULL,
  "can_download_originals" boolean DEFAULT false NOT NULL,
  "can_comment" boolean DEFAULT true NOT NULL,
  "can_approve" boolean DEFAULT false NOT NULL,
  "can_manage_release" boolean DEFAULT false NOT NULL,
  "can_manage_access" boolean DEFAULT false NOT NULL,
  "granted_by_user_id" uuid NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid,
  "revocation_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_project_access_grants_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id") ON DELETE CASCADE,
  CONSTRAINT "audio_project_access_grants_grantee_user_id_users_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "audio_project_access_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_project_access_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_project_access_grants_role_allowed" CHECK ("role" in ('owner', 'artist', 'producer', 'engineer', 'collaborator', 'reviewer')),
  CONSTRAINT "audio_project_access_grants_revocation_complete" CHECK (("revoked_at" is null and "revoked_by_user_id" is null) or ("revoked_at" is not null and "revoked_by_user_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_project_access_grants_active_project_user_idx" ON "audio_project_access_grants" ("project_id", "grantee_user_id") WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_project_access_grants_id_project_grantee_idx" ON "audio_project_access_grants" ("id", "project_id", "grantee_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_project_access_grants_id_project_manager_idx" ON "audio_project_access_grants" ("id", "project_id", "grantee_user_id", "can_manage_access");
--> statement-breakpoint
CREATE INDEX "audio_project_access_grants_user_revoked_idx" ON "audio_project_access_grants" ("grantee_user_id", "revoked_at");
--> statement-breakpoint
CREATE TABLE "audio_project_invitations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "target_email_normalized" text NOT NULL,
  "token_hash" text NOT NULL,
  "role" text NOT NULL,
  "permission_snapshot" jsonb NOT NULL,
  "invited_by_user_id" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone,
  "accepted_by_user_id" uuid,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_project_invitations_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id") ON DELETE CASCADE,
  CONSTRAINT "audio_project_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_project_invitations_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_project_invitations_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_project_invitations_role_allowed" CHECK ("role" in ('artist', 'producer', 'engineer', 'collaborator', 'reviewer')),
  CONSTRAINT "audio_project_invitations_target_email_normalized" CHECK ("target_email_normalized" = lower(trim("target_email_normalized")) and length("target_email_normalized") > 3),
  CONSTRAINT "audio_project_invitations_token_hash_valid" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audio_project_invitations_expiry_valid" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "audio_project_invitations_permission_snapshot_required" CHECK (jsonb_typeof("permission_snapshot") = 'object' and "permission_snapshot" <> '{}'::jsonb),
  CONSTRAINT "audio_project_invitations_acceptance_complete" CHECK (("accepted_at" is null and "accepted_by_user_id" is null) or ("accepted_at" is not null and "accepted_by_user_id" is not null)),
  CONSTRAINT "audio_project_invitations_revocation_complete" CHECK (("revoked_at" is null and "revoked_by_user_id" is null) or ("revoked_at" is not null and "revoked_by_user_id" is not null)),
  CONSTRAINT "audio_project_invitations_accepted_or_revoked" CHECK (not ("accepted_at" is not null and "revoked_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_project_invitations_token_hash_idx" ON "audio_project_invitations" ("token_hash");
--> statement-breakpoint
CREATE INDEX "audio_project_invitations_project_email_idx" ON "audio_project_invitations" ("project_id", "target_email_normalized");
--> statement-breakpoint
CREATE TABLE "audio_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "title" text NOT NULL,
  "asset_kind" text NOT NULL,
  "provenance_type" text DEFAULT 'user_upload' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_assets_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id"),
  CONSTRAINT "audio_assets_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_assets_kind_allowed" CHECK ("asset_kind" in ('master_audio', 'mix', 'stem', 'session', 'artwork', 'lyrics', 'video', 'document', 'other')),
  CONSTRAINT "audio_assets_status_allowed" CHECK ("status" in ('active', 'archived', 'restricted'))
);
--> statement-breakpoint
CREATE INDEX "audio_assets_project_status_idx" ON "audio_assets" ("project_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_assets_id_project_idx" ON "audio_assets" ("id", "project_id");
--> statement-breakpoint
CREATE TABLE "audio_upload_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "asset_id" uuid,
  "initiated_by_user_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "storage_provider" text NOT NULL,
  "storage_bucket" text NOT NULL,
  "provider_upload_id" text NOT NULL,
  "storage_key" text NOT NULL,
  "original_filename" text NOT NULL,
  "expected_mime_type" text NOT NULL,
  "expected_byte_size" bigint NOT NULL,
  "expected_sha256" text NOT NULL,
  "part_size_bytes" integer NOT NULL,
  "upload_status" text DEFAULT 'initiated' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_upload_sessions_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id"),
  CONSTRAINT "audio_upload_sessions_asset_id_audio_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "audio_assets"("id"),
  CONSTRAINT "audio_upload_sessions_initiated_by_user_id_users_id_fk" FOREIGN KEY ("initiated_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_upload_sessions_expected_byte_size_valid" CHECK ("expected_byte_size" > 0),
  CONSTRAINT "audio_upload_sessions_expected_sha_valid" CHECK ("expected_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audio_upload_sessions_status_allowed" CHECK ("upload_status" in ('initiated', 'uploading', 'uploaded', 'verifying', 'completed', 'quarantined', 'rejected', 'aborted', 'expired')),
  CONSTRAINT "audio_upload_sessions_completion_coherent" CHECK (("upload_status" = 'completed' and "completed_at" is not null) or ("upload_status" <> 'completed' and "completed_at" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_upload_sessions_provider_upload_idx" ON "audio_upload_sessions" ("storage_provider", "provider_upload_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_upload_sessions_project_idempotency_idx" ON "audio_upload_sessions" ("project_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_upload_sessions_id_project_idx" ON "audio_upload_sessions" ("id", "project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_upload_sessions_id_expected_identity_idx" ON "audio_upload_sessions" ("id", "expected_sha256", "expected_byte_size");
--> statement-breakpoint
CREATE INDEX "audio_upload_sessions_project_status_idx" ON "audio_upload_sessions" ("project_id", "upload_status");
--> statement-breakpoint
CREATE INDEX "audio_upload_sessions_cleanup_idx" ON "audio_upload_sessions" ("upload_status", "expires_at");
--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD CONSTRAINT "audio_upload_sessions_asset_project_fk" FOREIGN KEY ("asset_id", "project_id") REFERENCES "audio_assets"("id", "project_id");
--> statement-breakpoint
CREATE TABLE "audio_upload_parts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "upload_session_id" uuid NOT NULL,
  "part_number" integer NOT NULL,
  "byte_size" integer NOT NULL,
  "provider_etag" text NOT NULL,
  "provider_checksum" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_upload_parts_upload_session_id_audio_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "audio_upload_sessions"("id") ON DELETE CASCADE,
  CONSTRAINT "audio_upload_parts_part_valid" CHECK ("part_number" > 0 and "byte_size" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_upload_parts_session_part_idx" ON "audio_upload_parts" ("upload_session_id", "part_number");
--> statement-breakpoint
CREATE TABLE "audio_project_asset_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "performer_id" uuid NOT NULL,
  "asset_id" uuid NOT NULL,
  "uploaded_by_user_id" uuid NOT NULL,
  "upload_session_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "original_filename" text NOT NULL,
  "storage_provider" text NOT NULL,
  "storage_bucket" text NOT NULL,
  "storage_key" text NOT NULL,
  "provider_version_id" text,
  "mime_type" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "sha256" text NOT NULL,
  "duration_ms" integer,
  "codec" text,
  "sample_rate_hz" integer,
  "bit_depth" integer,
  "channel_count" integer,
  "integrity_status" "audio_asset_integrity_status" NOT NULL,
  "integrity_verifier_key" text NOT NULL,
  "integrity_verified_at" timestamp with time zone NOT NULL,
  "integrity_evidence" jsonb NOT NULL,
  "original_preserved" boolean DEFAULT true NOT NULL,
  "metadata" jsonb,
  "sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_project_asset_versions_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id"),
  CONSTRAINT "audio_project_asset_versions_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "performers"("id"),
  CONSTRAINT "audio_project_asset_versions_asset_id_audio_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "audio_assets"("id"),
  CONSTRAINT "audio_project_asset_versions_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_project_asset_versions_upload_session_id_audio_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "audio_upload_sessions"("id"),
  CONSTRAINT "audio_project_asset_versions_byte_size_valid" CHECK ("byte_size" > 0),
  CONSTRAINT "audio_project_asset_versions_version_valid" CHECK ("version_number" > 0),
  CONSTRAINT "audio_project_asset_versions_sha_valid" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audio_project_asset_versions_original_required" CHECK ("original_preserved" = true),
  CONSTRAINT "audio_project_asset_versions_integrity_verified" CHECK ("integrity_status" = 'verified'),
  CONSTRAINT "audio_project_asset_versions_integrity_evidence_required" CHECK (jsonb_typeof("integrity_evidence") = 'object' and "integrity_evidence" <> '{}'::jsonb),
  CONSTRAINT "audio_project_asset_versions_audio_metadata_valid" CHECK (("duration_ms" is null or "duration_ms" > 0) and ("sample_rate_hz" is null or "sample_rate_hz" > 0) and ("bit_depth" is null or "bit_depth" > 0) and ("channel_count" is null or "channel_count" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_project_asset_versions_asset_version_idx" ON "audio_project_asset_versions" ("asset_id", "version_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_project_asset_versions_id_project_idx" ON "audio_project_asset_versions" ("id", "project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_project_asset_versions_id_project_sha_idx" ON "audio_project_asset_versions" ("id", "project_id", "sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_project_asset_versions_id_performer_idx" ON "audio_project_asset_versions" ("id", "performer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_project_asset_versions_storage_object_idx" ON "audio_project_asset_versions" ("storage_provider", "storage_bucket", "storage_key");
--> statement-breakpoint
CREATE INDEX "audio_project_asset_versions_project_created_idx" ON "audio_project_asset_versions" ("project_id", "created_at");
--> statement-breakpoint
ALTER TABLE "audio_project_asset_versions" ADD CONSTRAINT "audio_project_asset_versions_project_performer_fk" FOREIGN KEY ("project_id", "performer_id") REFERENCES "audio_projects"("id", "performer_id");
--> statement-breakpoint
ALTER TABLE "audio_project_asset_versions" ADD CONSTRAINT "audio_project_asset_versions_asset_project_fk" FOREIGN KEY ("asset_id", "project_id") REFERENCES "audio_assets"("id", "project_id");
--> statement-breakpoint
ALTER TABLE "audio_project_asset_versions" ADD CONSTRAINT "audio_project_asset_versions_upload_project_fk" FOREIGN KEY ("upload_session_id", "project_id") REFERENCES "audio_upload_sessions"("id", "project_id");
--> statement-breakpoint
ALTER TABLE "audio_project_asset_versions" ADD CONSTRAINT "audio_project_asset_versions_upload_identity_fk" FOREIGN KEY ("upload_session_id", "sha256", "byte_size") REFERENCES "audio_upload_sessions"("id", "expected_sha256", "expected_byte_size");
--> statement-breakpoint
CREATE TABLE "audio_asset_derivatives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_asset_version_id" uuid NOT NULL,
  "derivative_kind" text NOT NULL,
  "storage_provider" text NOT NULL,
  "storage_bucket" text NOT NULL,
  "storage_key" text NOT NULL,
  "mime_type" text NOT NULL,
  "byte_size" bigint NOT NULL,
  "sha256" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_asset_derivatives_source_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("source_asset_version_id") REFERENCES "audio_project_asset_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "audio_asset_derivatives_sha_valid" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audio_asset_derivatives_byte_size_valid" CHECK ("byte_size" > 0),
  CONSTRAINT "audio_asset_derivatives_kind_allowed" CHECK ("derivative_kind" in ('preview_stream', 'waveform', 'transcript', 'thumbnail', 'continuum_source', 'continuum_render'))
);
--> statement-breakpoint
CREATE INDEX "audio_asset_derivatives_source_kind_idx" ON "audio_asset_derivatives" ("source_asset_version_id", "derivative_kind");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_asset_derivatives_storage_object_idx" ON "audio_asset_derivatives" ("storage_provider", "storage_bucket", "storage_key");
--> statement-breakpoint
CREATE TABLE "audio_file_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "member_one_user_id" uuid NOT NULL,
  "member_two_user_id" uuid NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "created_from_purpose" "audio_file_pairing_purpose" NOT NULL,
  "connected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid,
  "revocation_reason" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_file_connections_member_one_user_id_users_id_fk" FOREIGN KEY ("member_one_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_connections_member_two_user_id_users_id_fk" FOREIGN KEY ("member_two_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_connections_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_connections_canonical_pair_required" CHECK ("member_one_user_id"::text < "member_two_user_id"::text),
  CONSTRAINT "audio_file_connections_creator_must_be_member" CHECK ("created_by_user_id" = "member_one_user_id" or "created_by_user_id" = "member_two_user_id"),
  CONSTRAINT "audio_file_connections_revoker_must_be_member" CHECK ("revoked_by_user_id" is null or "revoked_by_user_id" = "member_one_user_id" or "revoked_by_user_id" = "member_two_user_id"),
  CONSTRAINT "audio_file_connections_revocation_complete" CHECK (("revoked_at" is null and "revoked_by_user_id" is null) or ("revoked_at" is not null and "revoked_by_user_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_file_connections_active_member_pair_idx" ON "audio_file_connections" ("member_one_user_id", "member_two_user_id") WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_file_connections_id_members_idx" ON "audio_file_connections" ("id", "member_one_user_id", "member_two_user_id");
--> statement-breakpoint
CREATE INDEX "audio_file_connections_member_one_revoked_idx" ON "audio_file_connections" ("member_one_user_id", "revoked_at");
--> statement-breakpoint
CREATE INDEX "audio_file_connections_member_two_revoked_idx" ON "audio_file_connections" ("member_two_user_id", "revoked_at");
--> statement-breakpoint
CREATE TABLE "audio_file_pairing_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "purpose" "audio_file_pairing_purpose" NOT NULL,
  "idempotency_key" text NOT NULL,
  "token_hash" text NOT NULL,
  "connection_label" text,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "consumed_by_user_id" uuid,
  "connection_id" uuid,
  "connection_member_one_user_id" uuid,
  "connection_member_two_user_id" uuid,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_file_pairing_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_pairing_tokens_consumed_by_user_id_users_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_pairing_tokens_connection_id_audio_file_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "audio_file_connections"("id"),
  CONSTRAINT "audio_file_pairing_tokens_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_pairing_tokens_token_hash_valid" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audio_file_pairing_tokens_expiry_valid" CHECK ("expires_at" > "created_at"),
  CONSTRAINT "audio_file_pairing_tokens_consumption_before_expiry" CHECK ("consumed_at" is null or "consumed_at" <= "expires_at"),
  CONSTRAINT "audio_file_pairing_tokens_claim_complete" CHECK (("consumed_at" is null and "consumed_by_user_id" is null and "connection_id" is null and "connection_member_one_user_id" is null and "connection_member_two_user_id" is null) or ("consumed_at" is not null and "consumed_by_user_id" is not null and "connection_id" is not null and "connection_member_one_user_id" is not null and "connection_member_two_user_id" is not null)),
  CONSTRAINT "audio_file_pairing_tokens_creator_cannot_claim" CHECK ("consumed_by_user_id" is null or "consumed_by_user_id" <> "created_by_user_id"),
  CONSTRAINT "audio_file_pairing_tokens_connection_members_match_claim" CHECK ("connection_id" is null or (("created_by_user_id" = "connection_member_one_user_id" and "consumed_by_user_id" = "connection_member_two_user_id") or ("created_by_user_id" = "connection_member_two_user_id" and "consumed_by_user_id" = "connection_member_one_user_id"))),
  CONSTRAINT "audio_file_pairing_tokens_consumed_or_revoked" CHECK (not ("consumed_at" is not null and "revoked_at" is not null)),
  CONSTRAINT "audio_file_pairing_tokens_revocation_complete" CHECK (("revoked_at" is null and "revoked_by_user_id" is null) or ("revoked_at" is not null and "revoked_by_user_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_file_pairing_tokens_token_hash_idx" ON "audio_file_pairing_tokens" ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_file_pairing_tokens_creator_idempotency_idx" ON "audio_file_pairing_tokens" ("created_by_user_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "audio_file_pairing_tokens_creator_expiry_idx" ON "audio_file_pairing_tokens" ("created_by_user_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "audio_file_pairing_tokens" ADD CONSTRAINT "audio_file_pairing_tokens_connection_members_fk" FOREIGN KEY ("connection_id", "connection_member_one_user_id", "connection_member_two_user_id") REFERENCES "audio_file_connections"("id", "member_one_user_id", "member_two_user_id");
--> statement-breakpoint
CREATE TABLE "audio_file_access_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL,
  "connection_member_one_user_id" uuid NOT NULL,
  "connection_member_two_user_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "asset_version_id" uuid NOT NULL,
  "grantor_project_access_grant_id" uuid NOT NULL,
  "grantor_can_manage_access" boolean DEFAULT true NOT NULL,
  "granted_by_user_id" uuid NOT NULL,
  "grantee_user_id" uuid NOT NULL,
  "can_stream_preview" boolean DEFAULT true NOT NULL,
  "can_download_original" boolean DEFAULT false NOT NULL,
  "can_upload_new_version" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_by_user_id" uuid,
  "revocation_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_file_access_grants_connection_id_audio_file_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "audio_file_connections"("id"),
  CONSTRAINT "audio_file_access_grants_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id"),
  CONSTRAINT "audio_file_access_grants_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("asset_version_id") REFERENCES "audio_project_asset_versions"("id"),
  CONSTRAINT "audio_file_access_grants_grantor_project_access_grant_id_audio_project_access_grants_id_fk" FOREIGN KEY ("grantor_project_access_grant_id") REFERENCES "audio_project_access_grants"("id"),
  CONSTRAINT "audio_file_access_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_access_grants_grantee_user_id_users_id_fk" FOREIGN KEY ("grantee_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_access_grants_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_access_grants_different_users" CHECK ("granted_by_user_id" <> "grantee_user_id"),
  CONSTRAINT "audio_file_access_grants_permission_required" CHECK ("can_stream_preview" = true or "can_download_original" = true or "can_upload_new_version" = true),
  CONSTRAINT "audio_file_access_grants_expiry_valid" CHECK ("expires_at" is null or "expires_at" > "created_at"),
  CONSTRAINT "audio_file_access_grants_connection_members_match_grant" CHECK (("granted_by_user_id" = "connection_member_one_user_id" and "grantee_user_id" = "connection_member_two_user_id") or ("granted_by_user_id" = "connection_member_two_user_id" and "grantee_user_id" = "connection_member_one_user_id")),
  CONSTRAINT "audio_file_access_grants_grantor_manage_access_required" CHECK ("grantor_can_manage_access" = true),
  CONSTRAINT "audio_file_access_grants_revoker_must_be_participant" CHECK ("revoked_by_user_id" is null or "revoked_by_user_id" = "granted_by_user_id" or "revoked_by_user_id" = "grantee_user_id"),
  CONSTRAINT "audio_file_access_grants_revocation_complete" CHECK (("revoked_at" is null and "revoked_by_user_id" is null) or ("revoked_at" is not null and "revoked_by_user_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_file_access_grants_active_connection_asset_grantee_idx" ON "audio_file_access_grants" ("connection_id", "asset_version_id", "grantee_user_id") WHERE "revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "audio_file_access_grants_grantee_expiry_idx" ON "audio_file_access_grants" ("grantee_user_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD CONSTRAINT "audio_file_access_grants_connection_members_fk" FOREIGN KEY ("connection_id", "connection_member_one_user_id", "connection_member_two_user_id") REFERENCES "audio_file_connections"("id", "member_one_user_id", "member_two_user_id");
--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD CONSTRAINT "audio_file_access_grants_asset_project_fk" FOREIGN KEY ("asset_version_id", "project_id") REFERENCES "audio_project_asset_versions"("id", "project_id");
--> statement-breakpoint
ALTER TABLE "audio_file_access_grants" ADD CONSTRAINT "audio_file_access_grants_grantor_project_access_fk" FOREIGN KEY ("grantor_project_access_grant_id", "project_id", "granted_by_user_id", "grantor_can_manage_access") REFERENCES "audio_project_access_grants"("id", "project_id", "grantee_user_id", "can_manage_access");
--> statement-breakpoint
CREATE TABLE "audio_file_connection_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "pairing_token_id" uuid,
  "project_id" uuid,
  "asset_version_id" uuid,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_file_connection_events_connection_id_audio_file_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "audio_file_connections"("id"),
  CONSTRAINT "audio_file_connection_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_file_connection_events_pairing_token_id_audio_file_pairing_tokens_id_fk" FOREIGN KEY ("pairing_token_id") REFERENCES "audio_file_pairing_tokens"("id"),
  CONSTRAINT "audio_file_connection_events_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id"),
  CONSTRAINT "audio_file_connection_events_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("asset_version_id") REFERENCES "audio_project_asset_versions"("id"),
  CONSTRAINT "audio_file_connection_events_event_type_allowed" CHECK ("event_type" in ('connected', 'file_requested', 'file_shared', 'connection_removed'))
);
--> statement-breakpoint
CREATE INDEX "audio_file_connection_events_connection_created_idx" ON "audio_file_connection_events" ("connection_id", "created_at");
--> statement-breakpoint
CREATE TABLE "audio_share_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "asset_version_id" uuid,
  "created_by_user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "recipient_email_hash" text,
  "recipient_label" text,
  "permissions" jsonb NOT NULL,
  "max_uses" integer,
  "use_count" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_share_grants_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id") ON DELETE CASCADE,
  CONSTRAINT "audio_share_grants_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("asset_version_id") REFERENCES "audio_project_asset_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "audio_share_grants_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_share_grants_use_count_valid" CHECK ("use_count" >= 0),
  CONSTRAINT "audio_share_grants_max_uses_valid" CHECK ("max_uses" is null or "max_uses" > 0),
  CONSTRAINT "audio_share_grants_within_max_uses" CHECK ("max_uses" is null or "use_count" <= "max_uses")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_share_grants_token_hash_idx" ON "audio_share_grants" ("token_hash");
--> statement-breakpoint
CREATE INDEX "audio_share_grants_project_expiry_idx" ON "audio_share_grants" ("project_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "audio_share_grants" ADD CONSTRAINT "audio_share_grants_asset_project_fk" FOREIGN KEY ("asset_version_id", "project_id") REFERENCES "audio_project_asset_versions"("id", "project_id");
--> statement-breakpoint
CREATE TABLE "audio_review_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "asset_version_id" uuid NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "timecode_ms" integer,
  "body" text,
  "supersedes_event_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_review_events_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("asset_version_id") REFERENCES "audio_project_asset_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "audio_review_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_review_events_event_type_allowed" CHECK ("event_type" in ('comment', 'approved', 'changes_requested', 'approval_withdrawn', 'resolved')),
  CONSTRAINT "audio_review_events_timecode_valid" CHECK ("timecode_ms" is null or "timecode_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX "audio_review_events_asset_created_idx" ON "audio_review_events" ("asset_version_id", "created_at");
--> statement-breakpoint
CREATE TABLE "music_recordings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL,
  "project_id" uuid,
  "master_asset_version_id" uuid,
  "title" text NOT NULL,
  "version_title" text,
  "primary_artist_name" text NOT NULL,
  "isrc" text,
  "duration_ms" integer,
  "is_explicit" boolean DEFAULT false NOT NULL,
  "language_code" text,
  "original_release_date" date,
  "rights_status" text DEFAULT 'draft' NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_recordings_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "performers"("id"),
  CONSTRAINT "music_recordings_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id") ON DELETE SET NULL,
  CONSTRAINT "music_recordings_master_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("master_asset_version_id") REFERENCES "audio_project_asset_versions"("id"),
  CONSTRAINT "music_recordings_isrc_valid" CHECK ("isrc" is null or "isrc" ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'),
  CONSTRAINT "music_recordings_duration_valid" CHECK ("duration_ms" is null or "duration_ms" > 0),
  CONSTRAINT "music_recordings_rights_status_allowed" CHECK ("rights_status" in ('draft', 'declared', 'under_review', 'cleared', 'blocked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "music_recordings_isrc_idx" ON "music_recordings" ("isrc") WHERE "isrc" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "music_recordings_id_project_idx" ON "music_recordings" ("id", "project_id");
--> statement-breakpoint
CREATE INDEX "music_recordings_performer_updated_idx" ON "music_recordings" ("performer_id", "updated_at");
--> statement-breakpoint
ALTER TABLE "music_recordings" ADD CONSTRAINT "music_recordings_project_performer_fk" FOREIGN KEY ("project_id", "performer_id") REFERENCES "audio_projects"("id", "performer_id");
--> statement-breakpoint
ALTER TABLE "music_recordings" ADD CONSTRAINT "music_recordings_master_performer_fk" FOREIGN KEY ("master_asset_version_id", "performer_id") REFERENCES "audio_project_asset_versions"("id", "performer_id");
--> statement-breakpoint
CREATE TABLE "music_recording_credits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recording_id" uuid NOT NULL,
  "user_id" uuid,
  "display_name" text NOT NULL,
  "role" text NOT NULL,
  "sequence" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_recording_credits_recording_id_music_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "music_recordings"("id") ON DELETE CASCADE,
  CONSTRAINT "music_recording_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX "music_recording_credits_recording_sequence_idx" ON "music_recording_credits" ("recording_id", "sequence");
--> statement-breakpoint
CREATE TABLE "music_releases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL,
  "project_id" uuid,
  "artwork_asset_version_id" uuid,
  "title" text NOT NULL,
  "primary_artist_name" text NOT NULL,
  "release_type" text NOT NULL,
  "distribution_mode" "music_distribution_mode" DEFAULT 'private' NOT NULL,
  "status" "music_release_status" DEFAULT 'draft' NOT NULL,
  "upc" text,
  "label_name" text,
  "p_line" text,
  "c_line" text,
  "original_release_date" date,
  "scheduled_release_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "territories" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_releases_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "performers"("id"),
  CONSTRAINT "music_releases_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id") ON DELETE SET NULL,
  CONSTRAINT "music_releases_artwork_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("artwork_asset_version_id") REFERENCES "audio_project_asset_versions"("id"),
  CONSTRAINT "music_releases_release_type_allowed" CHECK ("release_type" in ('single', 'ep', 'album', 'comedy_special', 'spoken_word', 'other')),
  CONSTRAINT "music_releases_upc_valid" CHECK ("upc" is null or "upc" ~ '^[0-9]{8,14}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "music_releases_upc_idx" ON "music_releases" ("upc") WHERE "upc" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX "music_releases_id_project_idx" ON "music_releases" ("id", "project_id");
--> statement-breakpoint
CREATE INDEX "music_releases_performer_status_idx" ON "music_releases" ("performer_id", "status");
--> statement-breakpoint
ALTER TABLE "music_releases" ADD CONSTRAINT "music_releases_project_performer_fk" FOREIGN KEY ("project_id", "performer_id") REFERENCES "audio_projects"("id", "performer_id");
--> statement-breakpoint
ALTER TABLE "music_releases" ADD CONSTRAINT "music_releases_artwork_performer_fk" FOREIGN KEY ("artwork_asset_version_id", "performer_id") REFERENCES "audio_project_asset_versions"("id", "performer_id");
--> statement-breakpoint
CREATE TABLE "music_release_recordings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "release_id" uuid NOT NULL,
  "recording_id" uuid NOT NULL,
  "disc_number" integer DEFAULT 1 NOT NULL,
  "track_number" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_release_recordings_release_id_music_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "music_releases"("id") ON DELETE CASCADE,
  CONSTRAINT "music_release_recordings_recording_id_music_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "music_recordings"("id"),
  CONSTRAINT "music_release_recordings_position_valid" CHECK ("disc_number" > 0 and "track_number" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "music_release_recordings_release_recording_idx" ON "music_release_recordings" ("release_id", "recording_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "music_release_recordings_release_position_idx" ON "music_release_recordings" ("release_id", "disc_number", "track_number");
--> statement-breakpoint
CREATE TABLE "music_rights_declarations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "release_id" uuid NOT NULL,
  "recording_id" uuid,
  "declared_by_user_id" uuid NOT NULL,
  "declaration_type" text NOT NULL,
  "terms_document_asset_version_id" uuid NOT NULL,
  "terms_version" text NOT NULL,
  "terms_hash" text NOT NULL,
  "declaration_text" text NOT NULL,
  "declaration_sha256" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "declared_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_rights_declarations_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id"),
  CONSTRAINT "music_rights_declarations_release_id_music_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "music_releases"("id"),
  CONSTRAINT "music_rights_declarations_recording_id_music_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "music_recordings"("id"),
  CONSTRAINT "music_rights_declarations_declared_by_user_id_users_id_fk" FOREIGN KEY ("declared_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "music_rights_declarations_terms_document_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("terms_document_asset_version_id") REFERENCES "audio_project_asset_versions"("id"),
  CONSTRAINT "music_rights_declarations_type_allowed" CHECK ("declaration_type" in ('master_control', 'composition_control', 'sample_clearance', 'cover_license', 'beat_license', 'artwork_control', 'performer_consent', 'ai_disclosure', 'distribution_authorization')),
  CONSTRAINT "music_rights_declarations_terms_hash_valid" CHECK ("terms_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "music_rights_declarations_declaration_sha_valid" CHECK ("declaration_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "music_rights_declarations_evidence_required" CHECK (jsonb_typeof("evidence") = 'object' and "evidence" <> '{}'::jsonb)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "music_rights_declarations_id_declaration_sha_idx" ON "music_rights_declarations" ("id", "declaration_sha256");
--> statement-breakpoint
CREATE INDEX "music_rights_declarations_release_type_idx" ON "music_rights_declarations" ("release_id", "declaration_type");
--> statement-breakpoint
ALTER TABLE "music_rights_declarations" ADD CONSTRAINT "music_rights_declarations_terms_document_project_hash_fk" FOREIGN KEY ("terms_document_asset_version_id", "project_id", "terms_hash") REFERENCES "audio_project_asset_versions"("id", "project_id", "sha256");
--> statement-breakpoint
ALTER TABLE "music_rights_declarations" ADD CONSTRAINT "music_rights_declarations_release_project_fk" FOREIGN KEY ("release_id", "project_id") REFERENCES "music_releases"("id", "project_id");
--> statement-breakpoint
ALTER TABLE "music_rights_declarations" ADD CONSTRAINT "music_rights_declarations_recording_project_fk" FOREIGN KEY ("recording_id", "project_id") REFERENCES "music_recordings"("id", "project_id");
--> statement-breakpoint
ALTER TABLE "music_rights_declarations" ADD CONSTRAINT "music_rights_declarations_recording_release_fk" FOREIGN KEY ("release_id", "recording_id") REFERENCES "music_release_recordings"("release_id", "recording_id");
--> statement-breakpoint
CREATE TABLE "music_rights_declaration_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "declaration_id" uuid NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "declaration_sha256" text NOT NULL,
  "evidence" jsonb NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_rights_declaration_events_declaration_id_music_rights_declarations_id_fk" FOREIGN KEY ("declaration_id") REFERENCES "music_rights_declarations"("id"),
  CONSTRAINT "music_rights_declaration_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id"),
  CONSTRAINT "music_rights_declaration_events_type_allowed" CHECK ("event_type" in ('declared', 'verified', 'rejected', 'revoked')),
  CONSTRAINT "music_rights_declaration_events_declaration_sha_valid" CHECK ("declaration_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "music_rights_declaration_events_evidence_required" CHECK (jsonb_typeof("evidence") = 'object' and "evidence" <> '{}'::jsonb)
);
--> statement-breakpoint
CREATE INDEX "music_rights_declaration_events_declaration_created_idx" ON "music_rights_declaration_events" ("declaration_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "music_rights_declaration_events_single_declared_idx" ON "music_rights_declaration_events" ("declaration_id") WHERE "event_type" = 'declared';
--> statement-breakpoint
CREATE UNIQUE INDEX "music_rights_declaration_events_single_review_outcome_idx" ON "music_rights_declaration_events" ("declaration_id") WHERE "event_type" in ('verified', 'rejected');
--> statement-breakpoint
CREATE UNIQUE INDEX "music_rights_declaration_events_single_revoked_idx" ON "music_rights_declaration_events" ("declaration_id") WHERE "event_type" = 'revoked';
--> statement-breakpoint
ALTER TABLE "music_rights_declaration_events" ADD CONSTRAINT "music_rights_declaration_events_declaration_sha_fk" FOREIGN KEY ("declaration_id", "declaration_sha256") REFERENCES "music_rights_declarations"("id", "declaration_sha256");
--> statement-breakpoint
CREATE TABLE "audio_creator_deals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "release_id" uuid,
  "recording_id" uuid,
  "proposed_by_user_id" uuid NOT NULL,
  "deal_type" text NOT NULL,
  "title" text NOT NULL,
  "terms_document_asset_version_id" uuid NOT NULL,
  "terms_sha256" text NOT NULL,
  "terms_version" text NOT NULL,
  "supersedes_deal_id" uuid,
  "effective_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_creator_deals_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id"),
  CONSTRAINT "audio_creator_deals_release_id_music_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "music_releases"("id"),
  CONSTRAINT "audio_creator_deals_recording_id_music_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "music_recordings"("id"),
  CONSTRAINT "audio_creator_deals_proposed_by_user_id_users_id_fk" FOREIGN KEY ("proposed_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_creator_deals_terms_document_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("terms_document_asset_version_id") REFERENCES "audio_project_asset_versions"("id"),
  CONSTRAINT "audio_creator_deals_supersedes_deal_id_audio_creator_deals_id_fk" FOREIGN KEY ("supersedes_deal_id") REFERENCES "audio_creator_deals"("id"),
  CONSTRAINT "audio_creator_deals_terms_sha_valid" CHECK ("terms_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audio_creator_deals_type_allowed" CHECK ("deal_type" in ('master_ownership', 'composition_ownership', 'producer_agreement', 'split_sheet', 'collaboration', 'license')),
  CONSTRAINT "audio_creator_deals_term_valid" CHECK ("expires_at" is null or "effective_at" is null or "expires_at" > "effective_at")
);
--> statement-breakpoint
CREATE INDEX "audio_creator_deals_project_created_idx" ON "audio_creator_deals" ("project_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_creator_deals_id_terms_sha_idx" ON "audio_creator_deals" ("id", "terms_sha256");
--> statement-breakpoint
ALTER TABLE "audio_creator_deals" ADD CONSTRAINT "audio_creator_deals_terms_document_project_hash_fk" FOREIGN KEY ("terms_document_asset_version_id", "project_id", "terms_sha256") REFERENCES "audio_project_asset_versions"("id", "project_id", "sha256");
--> statement-breakpoint
ALTER TABLE "audio_creator_deals" ADD CONSTRAINT "audio_creator_deals_release_project_fk" FOREIGN KEY ("release_id", "project_id") REFERENCES "music_releases"("id", "project_id");
--> statement-breakpoint
ALTER TABLE "audio_creator_deals" ADD CONSTRAINT "audio_creator_deals_recording_project_fk" FOREIGN KEY ("recording_id", "project_id") REFERENCES "music_recordings"("id", "project_id");
--> statement-breakpoint
CREATE TABLE "audio_creator_deal_parties" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deal_id" uuid NOT NULL,
  "user_id" uuid,
  "contact_email_hash" text,
  "display_name" text NOT NULL,
  "party_role" text NOT NULL,
  "acceptance_required" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_creator_deal_parties_deal_id_audio_creator_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "audio_creator_deals"("id"),
  CONSTRAINT "audio_creator_deal_parties_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_creator_deal_parties_account_required" CHECK ("user_id" is not null),
  CONSTRAINT "audio_creator_deal_parties_email_hash_valid" CHECK ("contact_email_hash" is null or "contact_email_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_creator_deal_parties_id_deal_idx" ON "audio_creator_deal_parties" ("id", "deal_id");
--> statement-breakpoint
CREATE INDEX "audio_creator_deal_parties_deal_role_idx" ON "audio_creator_deal_parties" ("deal_id", "party_role");
--> statement-breakpoint
CREATE TABLE "audio_creator_deal_allocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deal_id" uuid NOT NULL,
  "party_id" uuid NOT NULL,
  "allocation_type" text NOT NULL,
  "basis_points" integer,
  "fixed_amount_cents" integer,
  "currency" text DEFAULT 'USD' NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_creator_deal_allocations_deal_id_audio_creator_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "audio_creator_deals"("id"),
  CONSTRAINT "audio_creator_deal_allocations_party_id_audio_creator_deal_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "audio_creator_deal_parties"("id"),
  CONSTRAINT "audio_creator_deal_allocations_type_allowed" CHECK ("allocation_type" in ('master_ownership', 'composition_ownership', 'sale_net_receipts', 'streaming_net_receipts', 'producer_points', 'recoupment', 'fixed_fee')),
  CONSTRAINT "audio_creator_deal_allocations_value_required" CHECK ("basis_points" is not null or "fixed_amount_cents" is not null),
  CONSTRAINT "audio_creator_deal_allocations_basis_points_valid" CHECK ("basis_points" is null or ("basis_points" >= 0 and "basis_points" <= 10000)),
  CONSTRAINT "audio_creator_deal_allocations_fixed_amount_valid" CHECK ("fixed_amount_cents" is null or "fixed_amount_cents" >= 0)
);
--> statement-breakpoint
CREATE INDEX "audio_creator_deal_allocations_deal_type_idx" ON "audio_creator_deal_allocations" ("deal_id", "allocation_type");
--> statement-breakpoint
ALTER TABLE "audio_creator_deal_allocations" ADD CONSTRAINT "audio_creator_deal_allocations_party_deal_fk" FOREIGN KEY ("party_id", "deal_id") REFERENCES "audio_creator_deal_parties"("id", "deal_id");
--> statement-breakpoint
CREATE TABLE "audio_creator_deal_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deal_id" uuid NOT NULL,
  "party_id" uuid,
  "actor_user_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "terms_sha256" text NOT NULL,
  "authentication_evidence" jsonb,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_creator_deal_events_deal_id_audio_creator_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "audio_creator_deals"("id"),
  CONSTRAINT "audio_creator_deal_events_party_id_audio_creator_deal_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "audio_creator_deal_parties"("id"),
  CONSTRAINT "audio_creator_deal_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id"),
  CONSTRAINT "audio_creator_deal_events_event_type_allowed" CHECK ("event_type" in ('proposed', 'invited', 'viewed', 'accepted', 'rejected', 'withdrawn', 'superseded')),
  CONSTRAINT "audio_creator_deal_events_terms_sha_valid" CHECK ("terms_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audio_creator_deal_events_party_required" CHECK ("event_type" not in ('invited', 'viewed', 'accepted', 'rejected') or "party_id" is not null),
  CONSTRAINT "audio_creator_deal_events_authentication_evidence_required" CHECK ("event_type" not in ('accepted', 'rejected') or (jsonb_typeof("authentication_evidence") = 'object' and "authentication_evidence" <> '{}'::jsonb))
);
--> statement-breakpoint
CREATE INDEX "audio_creator_deal_events_deal_created_idx" ON "audio_creator_deal_events" ("deal_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_creator_deal_events_single_proposed_idx" ON "audio_creator_deal_events" ("deal_id") WHERE "event_type" = 'proposed';
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_creator_deal_events_single_party_response_idx" ON "audio_creator_deal_events" ("deal_id", "party_id") WHERE "event_type" in ('accepted', 'rejected');
--> statement-breakpoint
ALTER TABLE "audio_creator_deal_events" ADD CONSTRAINT "audio_creator_deal_events_party_deal_fk" FOREIGN KEY ("party_id", "deal_id") REFERENCES "audio_creator_deal_parties"("id", "deal_id");
--> statement-breakpoint
ALTER TABLE "audio_creator_deal_events" ADD CONSTRAINT "audio_creator_deal_events_terms_sha_fk" FOREIGN KEY ("deal_id", "terms_sha256") REFERENCES "audio_creator_deals"("id", "terms_sha256");
--> statement-breakpoint
CREATE TABLE "music_distribution_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "release_id" uuid NOT NULL,
  "provider_key" text NOT NULL,
  "destination_key" text NOT NULL,
  "delivery_status" text DEFAULT 'draft' NOT NULL,
  "provider_release_id" text,
  "destination_release_id" text,
  "metadata_fingerprint" text,
  "submitted_at" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "live_at" timestamp with time zone,
  "takedown_requested_at" timestamp with time zone,
  "taken_down_at" timestamp with time zone,
  "last_error" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_distribution_deliveries_release_id_music_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "music_releases"("id"),
  CONSTRAINT "music_distribution_deliveries_status_allowed" CHECK ("delivery_status" in ('draft', 'queued', 'submitted', 'accepted', 'live', 'correction_pending', 'takedown_requested', 'taken_down', 'failed')),
  CONSTRAINT "music_distribution_deliveries_provider_key_required" CHECK (length(trim("provider_key")) > 0),
  CONSTRAINT "music_distribution_deliveries_destination_key_required" CHECK (length(trim("destination_key")) > 0),
  CONSTRAINT "music_distribution_deliveries_metadata_fingerprint_valid" CHECK ("metadata_fingerprint" is null or "metadata_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "music_distribution_deliveries_release_destination_idx" ON "music_distribution_deliveries" ("release_id", "provider_key", "destination_key");
--> statement-breakpoint
CREATE INDEX "music_distribution_deliveries_status_updated_idx" ON "music_distribution_deliveries" ("delivery_status", "updated_at");
--> statement-breakpoint
CREATE TABLE "music_distribution_delivery_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" uuid NOT NULL,
  "actor_user_id" uuid,
  "event_type" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "provider_event_id" text,
  "previous_status" text,
  "next_status" text,
  "payload_sha256" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_distribution_delivery_events_delivery_id_music_distribution_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "music_distribution_deliveries"("id"),
  CONSTRAINT "music_distribution_delivery_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id"),
  CONSTRAINT "music_distribution_delivery_events_event_type_allowed" CHECK ("event_type" in ('delivery_created', 'delivery_attempted', 'provider_webhook', 'status_changed', 'correction_requested')),
  CONSTRAINT "music_distribution_delivery_events_idempotency_required" CHECK (length(trim("idempotency_key")) > 0),
  CONSTRAINT "music_distribution_delivery_events_payload_sha_valid" CHECK ("payload_sha256" is null or "payload_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "music_distribution_delivery_events_previous_status_allowed" CHECK ("previous_status" is null or "previous_status" in ('draft', 'queued', 'submitted', 'accepted', 'live', 'correction_pending', 'takedown_requested', 'taken_down', 'failed')),
  CONSTRAINT "music_distribution_delivery_events_next_status_allowed" CHECK ("next_status" is null or "next_status" in ('draft', 'queued', 'submitted', 'accepted', 'live', 'correction_pending', 'takedown_requested', 'taken_down', 'failed')),
  CONSTRAINT "music_distribution_delivery_events_status_shape" CHECK (("event_type" = 'delivery_created' and "previous_status" is null and "next_status" = 'draft') or ("event_type" = 'status_changed' and "previous_status" is not null and "next_status" is not null and "previous_status" <> "next_status") or ("event_type" not in ('delivery_created', 'status_changed') and "previous_status" is null and "next_status" is null)),
  CONSTRAINT "music_distribution_delivery_events_provider_shape" CHECK (("event_type" = 'provider_webhook' and "provider_event_id" is not null and "payload_sha256" is not null and "actor_user_id" is null) or ("event_type" <> 'provider_webhook' and "provider_event_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "music_distribution_delivery_events_delivery_idempotency_idx" ON "music_distribution_delivery_events" ("delivery_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "music_distribution_delivery_events_provider_event_idx" ON "music_distribution_delivery_events" ("provider_event_id") WHERE "provider_event_id" is not null;
--> statement-breakpoint
CREATE INDEX "music_distribution_delivery_events_delivery_created_idx" ON "music_distribution_delivery_events" ("delivery_id", "created_at");
--> statement-breakpoint
CREATE TABLE "music_catalog_transfers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL,
  "created_by_user_id" uuid NOT NULL,
  "source_distributor" text NOT NULL,
  "source_account_reference" text,
  "source_snapshot_asset_version_id" uuid,
  "status" "catalog_transfer_status" DEFAULT 'intake' NOT NULL,
  "expected_release_count" integer,
  "expected_recording_count" integer,
  "known_limitations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "continuity_evidence_fingerprint" text,
  "artist_cutover_approved_by_user_id" uuid,
  "artist_cutover_approved_at" timestamp with time zone,
  "artist_cutover_approval_fingerprint" text,
  "old_provider_takedown_requested_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_catalog_transfers_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "performers"("id"),
  CONSTRAINT "music_catalog_transfers_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "music_catalog_transfers_source_snapshot_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("source_snapshot_asset_version_id") REFERENCES "audio_project_asset_versions"("id"),
  CONSTRAINT "music_catalog_transfers_artist_cutover_approved_by_user_id_users_id_fk" FOREIGN KEY ("artist_cutover_approved_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "music_catalog_transfers_release_count_valid" CHECK ("expected_release_count" is null or "expected_release_count" > 0),
  CONSTRAINT "music_catalog_transfers_recording_count_valid" CHECK ("expected_recording_count" is null or "expected_recording_count" > 0),
  CONSTRAINT "music_catalog_transfers_known_limitations_array" CHECK (jsonb_typeof("known_limitations") = 'array'),
  CONSTRAINT "music_catalog_transfers_continuity_fingerprint_valid" CHECK ("continuity_evidence_fingerprint" is null or "continuity_evidence_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "music_catalog_transfers_approval_complete" CHECK (("artist_cutover_approved_by_user_id" is null and "artist_cutover_approved_at" is null and "artist_cutover_approval_fingerprint" is null) or ("artist_cutover_approved_by_user_id" is not null and "artist_cutover_approved_at" is not null and "artist_cutover_approval_fingerprint" is not null)),
  CONSTRAINT "music_catalog_transfers_approval_fingerprint_valid" CHECK ("artist_cutover_approval_fingerprint" is null or "artist_cutover_approval_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "music_catalog_transfers_performer_status_idx" ON "music_catalog_transfers" ("performer_id", "status");
--> statement-breakpoint
ALTER TABLE "music_catalog_transfers" ADD CONSTRAINT "music_catalog_transfers_snapshot_performer_fk" FOREIGN KEY ("source_snapshot_asset_version_id", "performer_id") REFERENCES "audio_project_asset_versions"("id", "performer_id");
--> statement-breakpoint
CREATE TABLE "music_catalog_transfer_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_id" uuid NOT NULL,
  "release_id" uuid,
  "source_release_id" text NOT NULL,
  "existing_upc" text,
  "source_metadata_snapshot" jsonb NOT NULL,
  "artist_identity_map" jsonb NOT NULL,
  "audio_manifest" jsonb NOT NULL,
  "artwork_manifest" jsonb,
  "rights_evidence" jsonb,
  "commercial_terms" jsonb,
  "baseline_public_state" jsonb,
  "store_continuity_report" jsonb,
  "parity_status" text DEFAULT 'pending' NOT NULL,
  "store_match_status" text DEFAULT 'pending' NOT NULL,
  "overlap_verified_at" timestamp with time zone,
  "known_limitations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_catalog_transfer_items_transfer_id_music_catalog_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "music_catalog_transfers"("id"),
  CONSTRAINT "music_catalog_transfer_items_release_id_music_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "music_releases"("id"),
  CONSTRAINT "music_catalog_transfer_items_upc_valid" CHECK ("existing_upc" is null or "existing_upc" ~ '^[0-9]{8,14}$'),
  CONSTRAINT "music_catalog_transfer_items_parity_allowed" CHECK ("parity_status" in ('pending', 'matched', 'mismatch', 'blocked')),
  CONSTRAINT "music_catalog_transfer_items_store_match_allowed" CHECK ("store_match_status" in ('pending', 'matched', 'partial', 'failed', 'known_unavoidable_loss')),
  CONSTRAINT "music_catalog_transfer_items_known_limitations_array" CHECK (jsonb_typeof("known_limitations") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "music_catalog_transfer_items_transfer_source_release_idx" ON "music_catalog_transfer_items" ("transfer_id", "source_release_id");
--> statement-breakpoint
CREATE INDEX "music_catalog_transfer_items_transfer_parity_idx" ON "music_catalog_transfer_items" ("transfer_id", "parity_status");
--> statement-breakpoint
CREATE TABLE "music_catalog_transfer_recordings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_item_id" uuid NOT NULL,
  "recording_id" uuid,
  "source_recording_id" text NOT NULL,
  "existing_isrc" text,
  "source_master_sha256" text NOT NULL,
  "source_audio_identity" jsonb NOT NULL,
  "source_metadata_snapshot" jsonb NOT NULL,
  "source_store_identifiers" jsonb NOT NULL,
  "baseline_public_state" jsonb,
  "continuity_report" jsonb,
  "parity_status" text DEFAULT 'pending' NOT NULL,
  "store_match_status" text DEFAULT 'pending' NOT NULL,
  "overlap_verified_at" timestamp with time zone,
  "known_limitations" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_catalog_transfer_recordings_transfer_item_id_music_catalog_transfer_items_id_fk" FOREIGN KEY ("transfer_item_id") REFERENCES "music_catalog_transfer_items"("id"),
  CONSTRAINT "music_catalog_transfer_recordings_recording_id_music_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "music_recordings"("id"),
  CONSTRAINT "music_catalog_transfer_recordings_isrc_valid" CHECK ("existing_isrc" is null or "existing_isrc" ~ '^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$'),
  CONSTRAINT "music_catalog_transfer_recordings_master_sha_valid" CHECK ("source_master_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "music_catalog_transfer_recordings_parity_allowed" CHECK ("parity_status" in ('pending', 'matched', 'mismatch', 'blocked')),
  CONSTRAINT "music_catalog_transfer_recordings_store_match_allowed" CHECK ("store_match_status" in ('pending', 'matched', 'partial', 'failed', 'known_unavoidable_loss')),
  CONSTRAINT "music_catalog_transfer_recordings_known_limitations_array" CHECK (jsonb_typeof("known_limitations") = 'array')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "music_catalog_transfer_recordings_item_source_recording_idx" ON "music_catalog_transfer_recordings" ("transfer_item_id", "source_recording_id");
--> statement-breakpoint
CREATE INDEX "music_catalog_transfer_recordings_item_parity_idx" ON "music_catalog_transfer_recordings" ("transfer_item_id", "parity_status");
--> statement-breakpoint
CREATE TABLE "music_catalog_transfer_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "transfer_id" uuid NOT NULL,
  "actor_user_id" uuid NOT NULL,
  "previous_status" "catalog_transfer_status",
  "next_status" "catalog_transfer_status" NOT NULL,
  "reason" text NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "music_catalog_transfer_events_transfer_id_music_catalog_transfers_id_fk" FOREIGN KEY ("transfer_id") REFERENCES "music_catalog_transfers"("id"),
  CONSTRAINT "music_catalog_transfer_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
);
--> statement-breakpoint
CREATE INDEX "music_catalog_transfer_events_transfer_created_idx" ON "music_catalog_transfer_events" ("transfer_id", "created_at");
--> statement-breakpoint
CREATE TABLE "media_connector_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid,
  "asset_version_id" uuid,
  "provider_key" text NOT NULL,
  "external_source_id" text NOT NULL,
  "source_kind" text NOT NULL,
  "connection_status" text DEFAULT 'linked' NOT NULL,
  "capability_snapshot" jsonb NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "media_connector_links_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "audio_projects"("id") ON DELETE CASCADE,
  CONSTRAINT "media_connector_links_asset_version_id_audio_project_asset_versions_id_fk" FOREIGN KEY ("asset_version_id") REFERENCES "audio_project_asset_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "media_connector_links_resource_required" CHECK ("project_id" is not null or "asset_version_id" is not null),
  CONSTRAINT "media_connector_links_status_allowed" CHECK ("connection_status" in ('linked', 'syncing', 'ready', 'failed', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_connector_links_provider_source_idx" ON "media_connector_links" ("provider_key", "external_source_id");
--> statement-breakpoint
CREATE INDEX "media_connector_links_project_status_idx" ON "media_connector_links" ("project_id", "connection_status");
--> statement-breakpoint
ALTER TABLE "media_connector_links" ADD CONSTRAINT "media_connector_links_asset_project_fk" FOREIGN KEY ("asset_version_id", "project_id") REFERENCES "audio_project_asset_versions"("id", "project_id");
--> statement-breakpoint
CREATE FUNCTION "sway_reject_immutable_audio_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Sway audio evidence rows are immutable; append a new version or event instead.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_audio_project_insert"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM performers performer
    JOIN users actor ON actor.id = NEW.created_by_user_id
    WHERE performer.id = NEW.performer_id
      AND (performer.owner_user_id = NEW.created_by_user_id OR actor.role IN ('admin', 'support'))
  ) THEN
    RAISE EXCEPTION 'Audio projects may be created only by the performer owner or an authorized operator.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_project_access_grant"() RETURNS trigger AS $$
DECLARE
  performer_owner_user_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT performer.owner_user_id INTO performer_owner_user_id
    FROM audio_projects project
    JOIN performers performer ON performer.id = project.performer_id
    WHERE project.id = NEW.project_id;

    IF performer_owner_user_id IS NULL THEN
      RAISE EXCEPTION 'Project access requires an existing performer project.';
    END IF;
    IF NEW.role = 'owner' THEN
      IF NEW.grantee_user_id <> performer_owner_user_id
        OR NEW.granted_by_user_id <> performer_owner_user_id
        OR NEW.can_upload_versions <> true
        OR NEW.can_download_originals <> true
        OR NEW.can_comment <> true
        OR NEW.can_approve <> true
        OR NEW.can_manage_release <> true
        OR NEW.can_manage_access <> true
        OR NEW.expires_at IS NOT NULL THEN
        RAISE EXCEPTION 'The owner access grant is a non-expiring, full-authority bootstrap for the performer owner.';
      END IF;
    ELSIF NOT EXISTS (
      SELECT 1 FROM audio_project_access_grants authority
      WHERE authority.project_id = NEW.project_id
        AND authority.grantee_user_id = NEW.granted_by_user_id
        AND authority.can_manage_access = true
        AND authority.revoked_at IS NULL
        AND (authority.expires_at IS NULL OR authority.expires_at > now())
    ) THEN
      RAISE EXCEPTION 'Project access grants require active access-management authority.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.grantee_user_id IS DISTINCT FROM OLD.grantee_user_id
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.can_upload_versions IS DISTINCT FROM OLD.can_upload_versions
    OR NEW.can_download_originals IS DISTINCT FROM OLD.can_download_originals
    OR NEW.can_comment IS DISTINCT FROM OLD.can_comment
    OR NEW.can_approve IS DISTINCT FROM OLD.can_approve
    OR NEW.can_manage_release IS DISTINCT FROM OLD.can_manage_release
    OR NEW.can_manage_access IS DISTINCT FROM OLD.can_manage_access
    OR NEW.granted_by_user_id IS DISTINCT FROM OLD.granted_by_user_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Project access grant scope is immutable; revoke and issue a new grant.';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Revoked project access grants cannot be restored or changed.';
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    IF OLD.role = 'owner' THEN
      RAISE EXCEPTION 'The bootstrap owner grant cannot be revoked without an explicit ownership-transfer workflow.';
    END IF;
    IF NEW.revoked_by_user_id <> OLD.grantee_user_id AND NOT EXISTS (
      SELECT 1 FROM audio_project_access_grants authority
      WHERE authority.project_id = OLD.project_id
        AND authority.grantee_user_id = NEW.revoked_by_user_id
        AND authority.can_manage_access = true
        AND authority.revoked_at IS NULL
        AND (authority.expires_at IS NULL OR authority.expires_at > now())
    ) THEN
      RAISE EXCEPTION 'Project access may be revoked only by its grantee or an active access manager.';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_project_invitation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.accepted_at IS NOT NULL OR NEW.accepted_by_user_id IS NOT NULL
      OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'Project invitations must begin pending and active.';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM audio_project_access_grants authority
      WHERE authority.project_id = NEW.project_id
        AND authority.grantee_user_id = NEW.invited_by_user_id
        AND authority.can_manage_access = true
        AND authority.revoked_at IS NULL
        AND (authority.expires_at IS NULL OR authority.expires_at > now())
    ) THEN
      RAISE EXCEPTION 'Project invitations require active access-management authority.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.target_email_normalized IS DISTINCT FROM OLD.target_email_normalized
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.role IS DISTINCT FROM OLD.role
    OR NEW.permission_snapshot IS DISTINCT FROM OLD.permission_snapshot
    OR NEW.invited_by_user_id IS DISTINCT FROM OLD.invited_by_user_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Project invitation identity is immutable.';
  END IF;
  IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Accepted or revoked project invitations are terminal.';
  END IF;
  IF NEW.accepted_at IS NOT NULL AND (
    clock_timestamp() > OLD.expires_at OR NOT EXISTS (
      SELECT 1 FROM users claimant
      WHERE claimant.id = NEW.accepted_by_user_id
        AND lower(trim(claimant.email)) = NEW.target_email_normalized
        AND claimant.email_verified_at IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Invitation acceptance requires the verified target email before expiry.';
  END IF;
  IF NEW.accepted_at IS NOT NULL THEN
    NEW.accepted_at := clock_timestamp();
  END IF;
  IF NEW.revoked_at IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM audio_project_access_grants authority
    WHERE authority.project_id = NEW.project_id
      AND authority.grantee_user_id = NEW.revoked_by_user_id
      AND authority.can_manage_access = true
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > now())
  ) THEN
    RAISE EXCEPTION 'Project invitation revocation requires active access-management authority.';
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := clock_timestamp();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_audio_asset_insert"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audio_project_access_grants authority
    WHERE authority.project_id = NEW.project_id
      AND authority.grantee_user_id = NEW.created_by_user_id
      AND authority.can_upload_versions = true
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Audio asset creation requires active upload authority for the project.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_upload_session_state"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.upload_status <> 'initiated' OR NEW.completed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Audio upload sessions must begin in initiated state.';
    END IF;
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
    RETURN NEW;
  END IF;

  IF NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.asset_id IS DISTINCT FROM OLD.asset_id
    OR NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id
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

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_audio_asset_version_seal"() RETURNS trigger AS $$
DECLARE
  upload_record audio_upload_sessions%ROWTYPE;
BEGIN
  SELECT * INTO upload_record
  FROM audio_upload_sessions
  WHERE id = NEW.upload_session_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A sealed audio version requires an existing upload session.';
  END IF;
  IF upload_record.upload_status <> 'completed' OR upload_record.completed_at IS NULL THEN
    RAISE EXCEPTION 'A sealed audio version requires a completed upload session.';
  END IF;
  IF upload_record.project_id <> NEW.project_id
    OR upload_record.asset_id IS DISTINCT FROM NEW.asset_id
    OR upload_record.initiated_by_user_id <> NEW.uploaded_by_user_id
    OR upload_record.storage_provider <> NEW.storage_provider
    OR upload_record.storage_bucket <> NEW.storage_bucket
    OR upload_record.storage_key <> NEW.storage_key
    OR upload_record.original_filename <> NEW.original_filename
    OR upload_record.expected_byte_size <> NEW.byte_size
    OR upload_record.expected_sha256 <> NEW.sha256 THEN
    RAISE EXCEPTION 'Sealed audio version identity does not match its verified upload session.';
  END IF;
  IF NEW.integrity_status <> 'verified'
    OR NEW.integrity_verified_at < upload_record.completed_at
    OR jsonb_typeof(NEW.integrity_evidence) <> 'object'
    OR NEW.integrity_evidence = '{}'::jsonb THEN
    RAISE EXCEPTION 'A sealed audio version requires post-upload verification evidence.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audio_project_access_grants authority
    WHERE authority.project_id = NEW.project_id
      AND authority.grantee_user_id = NEW.uploaded_by_user_id
      AND authority.can_upload_versions = true
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Sealing an audio version requires active upload authority for the project.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_file_pairing_token_state"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.consumed_at IS NOT NULL OR NEW.consumed_by_user_id IS NOT NULL
      OR NEW.connection_id IS NOT NULL OR NEW.connection_member_one_user_id IS NOT NULL
      OR NEW.connection_member_two_user_id IS NOT NULL OR NEW.revoked_at IS NOT NULL
      OR NEW.revoked_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'File pairing tokens must begin unused and active.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.purpose IS DISTINCT FROM OLD.purpose
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
    OR NEW.connection_label IS DISTINCT FROM OLD.connection_label
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'File pairing token identity is immutable.';
  END IF;
  IF OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Consumed or revoked file pairing tokens are terminal.';
  END IF;
  IF NEW.consumed_at IS NOT NULL AND clock_timestamp() > OLD.expires_at THEN
    RAISE EXCEPTION 'Expired file pairing tokens cannot be consumed.';
  END IF;
  IF NEW.consumed_at IS NOT NULL THEN
    NEW.consumed_at := clock_timestamp();
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := clock_timestamp();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_file_connection_state"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.revoked_at IS NOT NULL OR NEW.revoked_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'File connections must begin active.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.member_one_user_id IS DISTINCT FROM OLD.member_one_user_id
    OR NEW.member_two_user_id IS DISTINCT FROM OLD.member_two_user_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.created_from_purpose IS DISTINCT FROM OLD.created_from_purpose
    OR NEW.connected_at IS DISTINCT FROM OLD.connected_at THEN
    RAISE EXCEPTION 'File connection identity is immutable.';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Revoked file connections cannot be restored or changed.';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_audio_file_access_grant"() RETURNS trigger AS $$
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
      AND (authority.expires_at IS NULL OR authority.expires_at > now())
  ) THEN
    RAISE EXCEPTION 'Selected-file access requires active project access-management authority.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_file_access_grant_state"() RETURNS trigger AS $$
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
    OR NEW.can_stream_preview IS DISTINCT FROM OLD.can_stream_preview
    OR NEW.can_download_original IS DISTINCT FROM OLD.can_download_original
    OR NEW.can_upload_new_version IS DISTINCT FROM OLD.can_upload_new_version
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Selected-file access grant scope is immutable.';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Revoked selected-file access grants cannot be restored or changed.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_audio_file_connection_event_actor"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audio_file_connections connection
    WHERE connection.id = NEW.connection_id
      AND NEW.actor_user_id IN (connection.member_one_user_id, connection.member_two_user_id)
  ) THEN
    RAISE EXCEPTION 'File connection events require a connection participant.';
  END IF;
  IF NEW.event_type = 'connected' AND NEW.pairing_token_id IS NULL THEN
    RAISE EXCEPTION 'Connected events require their pairing token.';
  END IF;
  IF NEW.event_type = 'file_shared' AND (NEW.project_id IS NULL OR NEW.asset_version_id IS NULL) THEN
    RAISE EXCEPTION 'File-shared events require the selected project and asset version.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_rights_declaration"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audio_project_access_grants authority
    WHERE authority.project_id = NEW.project_id
      AND authority.grantee_user_id = NEW.declared_by_user_id
      AND authority.can_manage_release = true
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > now())
  ) THEN
    RAISE EXCEPTION 'Rights declarations require active release-management authority.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_record_rights_declaration_created"() RETURNS trigger AS $$
BEGIN
  INSERT INTO music_rights_declaration_events (
    declaration_id, actor_user_id, event_type, declaration_sha256, evidence, reason
  ) VALUES (
    NEW.id, NEW.declared_by_user_id, 'declared', NEW.declaration_sha256, NEW.evidence, 'Initial immutable declaration'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_rights_declaration_event"() RETURNS trigger AS $$
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
        AND authority.can_manage_release = true
        AND authority.revoked_at IS NULL
        AND (authority.expires_at IS NULL OR authority.expires_at > now())
    ) THEN
      RAISE EXCEPTION 'Rights declaration review events require active release-management authority.';
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
--> statement-breakpoint
CREATE FUNCTION "sway_validate_creator_deal"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audio_project_access_grants authority
    WHERE authority.project_id = NEW.project_id
      AND authority.grantee_user_id = NEW.proposed_by_user_id
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > now())
  ) THEN
    RAISE EXCEPTION 'Creator deals require an active project participant.';
  END IF;
  IF NEW.supersedes_deal_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM audio_creator_deals prior
    WHERE prior.id = NEW.supersedes_deal_id AND prior.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'A creator deal may supersede only a deal in the same project.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_record_creator_deal_proposed"() RETURNS trigger AS $$
BEGIN
  INSERT INTO audio_creator_deal_events (
    deal_id, actor_user_id, event_type, terms_sha256, metadata
  ) VALUES (
    NEW.id, NEW.proposed_by_user_id, 'proposed', NEW.terms_sha256,
    jsonb_build_object('termsVersion', NEW.terms_version)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_creator_deal_structure_insert"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM audio_creator_deals deal WHERE deal.id = NEW.deal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Creator deal structure requires an existing deal.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM audio_creator_deal_events event
    WHERE event.deal_id = NEW.deal_id AND event.event_type <> 'proposed'
  ) THEN
    RAISE EXCEPTION 'Creator deal parties and allocations are sealed after invitation activity begins.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_creator_deal_event"() RETURNS trigger AS $$
DECLARE
  deal_record audio_creator_deals%ROWTYPE;
  party_user_id uuid;
BEGIN
  SELECT * INTO deal_record FROM audio_creator_deals WHERE id = NEW.deal_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Creator deal event requires an existing deal.';
  END IF;
  IF NEW.event_type = 'proposed' AND (
    NEW.actor_user_id <> deal_record.proposed_by_user_id OR NEW.party_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'The proposed event must use the deal proposer without a party response.';
  END IF;
  IF NEW.event_type = 'invited' AND NEW.actor_user_id <> deal_record.proposed_by_user_id THEN
    RAISE EXCEPTION 'Creator deal invitations must be sent by the deal proposer.';
  END IF;
  IF NEW.event_type IN ('withdrawn', 'superseded') AND NEW.actor_user_id <> deal_record.proposed_by_user_id THEN
    RAISE EXCEPTION 'Only the deal proposer may withdraw or supersede this deal version.';
  END IF;
  IF NEW.event_type IN ('viewed', 'accepted', 'rejected') THEN
    SELECT party.user_id INTO party_user_id
    FROM audio_creator_deal_parties party
    WHERE party.id = NEW.party_id AND party.deal_id = NEW.deal_id;
    IF party_user_id IS NULL OR party_user_id <> NEW.actor_user_id THEN
      RAISE EXCEPTION 'Creator deal viewing, acceptance, or rejection must be made by the named account party.';
    END IF;
  END IF;
  IF NEW.event_type IN ('accepted', 'rejected') THEN
    IF EXISTS (
      SELECT 1 FROM audio_creator_deal_events event
      WHERE event.deal_id = NEW.deal_id
        AND event.party_id = NEW.party_id
        AND event.event_type IN ('accepted', 'rejected')
    ) THEN
      RAISE EXCEPTION 'A creator deal party already recorded its response to this version.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_distribution_delivery_insert"() RETURNS trigger AS $$
DECLARE
  actor_setting text;
BEGIN
  actor_setting := nullif(current_setting('sway.actor_user_id', true), '');
  IF NEW.delivery_status <> 'draft'
    OR NEW.provider_release_id IS NOT NULL OR NEW.destination_release_id IS NOT NULL
    OR NEW.submitted_at IS NOT NULL OR NEW.accepted_at IS NOT NULL OR NEW.live_at IS NOT NULL
    OR NEW.takedown_requested_at IS NOT NULL OR NEW.taken_down_at IS NOT NULL
    OR NEW.last_error IS NOT NULL THEN
    RAISE EXCEPTION 'Distribution deliveries must begin as a clean draft.';
  END IF;
  IF actor_setting IS NULL OR NOT EXISTS (
    SELECT 1
    FROM music_releases release
    JOIN audio_project_access_grants authority ON authority.project_id = release.project_id
    WHERE release.id = NEW.release_id
      AND authority.grantee_user_id = actor_setting::uuid
      AND authority.can_manage_release = true
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Distribution delivery creation requires active release-management authority.';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_record_distribution_delivery_created"() RETURNS trigger AS $$
DECLARE
  actor_setting text;
  previous_guard text;
BEGIN
  actor_setting := nullif(current_setting('sway.actor_user_id', true), '');
  previous_guard := current_setting('sway.delivery_transition_in_progress', true);
  PERFORM set_config('sway.delivery_transition_in_progress', NEW.id::text, true);
  INSERT INTO music_distribution_delivery_events (
    delivery_id, actor_user_id, event_type, idempotency_key, next_status, payload_sha256, metadata
  ) VALUES (
    NEW.id, actor_setting::uuid, 'delivery_created', 'created:' || NEW.id::text, 'draft',
    NEW.metadata_fingerprint,
    jsonb_strip_nulls(jsonb_build_object(
      'reason', 'Initial delivery draft',
      'metadataFingerprint', NEW.metadata_fingerprint
    ))
  );
  PERFORM set_config('sway.delivery_transition_in_progress', COALESCE(previous_guard, ''), true);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('sway.delivery_transition_in_progress', COALESCE(previous_guard, ''), true);
  RAISE;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_record_distribution_delivery_transition"() RETURNS trigger AS $$
DECLARE
  actor_setting text;
  reason_setting text;
  idempotency_setting text;
  payload_setting text;
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
    (OLD.delivery_status = 'correction_pending' AND NEW.delivery_status IN ('queued', 'submitted', 'failed')) OR
    (OLD.delivery_status = 'takedown_requested' AND NEW.delivery_status IN ('taken_down', 'failed')) OR
    (OLD.delivery_status = 'failed' AND NEW.delivery_status IN ('queued', 'correction_pending'))
  ) THEN
    RAISE EXCEPTION 'Invalid distribution delivery transition from % to %.', OLD.delivery_status, NEW.delivery_status;
  END IF;

  actor_setting := nullif(current_setting('sway.actor_user_id', true), '');
  reason_setting := nullif(current_setting('sway.delivery_transition_reason', true), '');
  idempotency_setting := nullif(current_setting('sway.delivery_transition_idempotency_key', true), '');
  payload_setting := nullif(current_setting('sway.delivery_transition_payload_sha256', true), '');
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
  IF NOT EXISTS (
    SELECT 1
    FROM music_releases release
    JOIN audio_project_access_grants authority ON authority.project_id = release.project_id
    WHERE release.id = NEW.release_id
      AND authority.grantee_user_id = actor_setting::uuid
      AND authority.can_manage_release = true
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Distribution delivery transitions require active release-management authority.';
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
--> statement-breakpoint
CREATE FUNCTION "sway_validate_distribution_delivery_event"() RETURNS trigger AS $$
DECLARE
  delivery_record music_distribution_deliveries%ROWTYPE;
  actor_setting text;
  webhook_verified_setting text;
  webhook_provider_setting text;
BEGIN
  SELECT * INTO delivery_record
  FROM music_distribution_deliveries
  WHERE id = NEW.delivery_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Distribution delivery events require an existing delivery.';
  END IF;

  IF NEW.event_type IN ('delivery_created', 'status_changed') THEN
    IF pg_trigger_depth() < 2 OR
      current_setting('sway.delivery_transition_in_progress', true) IS DISTINCT FROM NEW.delivery_id::text THEN
      RAISE EXCEPTION 'Delivery creation and status events may be appended only by the coupled delivery trigger.';
    END IF;
    IF NEW.actor_user_id IS NULL THEN
      RAISE EXCEPTION 'Coupled delivery events require an authenticated actor.';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.payload_sha256 IS NULL THEN
    RAISE EXCEPTION 'Manual delivery events require a payload fingerprint.';
  END IF;

  IF NEW.event_type = 'provider_webhook' THEN
    webhook_verified_setting := nullif(current_setting('sway.provider_webhook_verified', true), '');
    webhook_provider_setting := nullif(current_setting('sway.provider_webhook_provider_key', true), '');
    IF webhook_verified_setting IS DISTINCT FROM 'true'
      OR webhook_provider_setting IS DISTINCT FROM delivery_record.provider_key THEN
      RAISE EXCEPTION 'Provider webhook events require verified provider service context.';
    END IF;
  ELSE
    actor_setting := nullif(current_setting('sway.actor_user_id', true), '');
    IF actor_setting IS NULL OR NEW.actor_user_id::text IS DISTINCT FROM actor_setting OR NOT EXISTS (
      SELECT 1
      FROM music_releases release
      JOIN audio_project_access_grants authority ON authority.project_id = release.project_id
      WHERE release.id = delivery_record.release_id
        AND authority.grantee_user_id = NEW.actor_user_id
        AND authority.can_manage_release = true
        AND authority.revoked_at IS NULL
        AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
    ) THEN
      RAISE EXCEPTION 'Manual delivery events require active release-management authority.';
    END IF;
  END IF;

  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_catalog_transfer_insert"() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'intake'
    OR NEW.continuity_evidence_fingerprint IS NOT NULL
    OR NEW.artist_cutover_approved_by_user_id IS NOT NULL
    OR NEW.artist_cutover_approved_at IS NOT NULL
    OR NEW.artist_cutover_approval_fingerprint IS NOT NULL
    OR NEW.old_provider_takedown_requested_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Catalog transfers must begin in a clean intake state.';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM performers performer
    JOIN users actor ON actor.id = NEW.created_by_user_id
    WHERE performer.id = NEW.performer_id
      AND (performer.owner_user_id = NEW.created_by_user_id OR actor.role IN ('admin', 'support'))
  ) THEN
    RAISE EXCEPTION 'Catalog transfers may be opened only by the performer owner or an authorized operator.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_catalog_transfer_child_scope"() RETURNS trigger AS $$
DECLARE
  transfer_status catalog_transfer_status;
  transfer_performer_id uuid;
  transfer_continuity_fingerprint text;
  target_transfer_id uuid;
  target_release_id uuid;
  target_recording_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'music_catalog_transfer_items' THEN
    IF TG_OP = 'UPDATE' AND (
      NEW.transfer_id IS DISTINCT FROM OLD.transfer_id
      OR NEW.source_release_id IS DISTINCT FROM OLD.source_release_id
      OR NEW.release_id IS DISTINCT FROM OLD.release_id
    ) THEN
      RAISE EXCEPTION 'Catalog transfer item identity is immutable.';
    END IF;
    IF TG_OP = 'DELETE' THEN
      target_transfer_id := OLD.transfer_id;
      target_release_id := OLD.release_id;
    ELSE
      target_transfer_id := NEW.transfer_id;
      target_release_id := NEW.release_id;
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND (
      NEW.transfer_item_id IS DISTINCT FROM OLD.transfer_item_id
      OR NEW.source_recording_id IS DISTINCT FROM OLD.source_recording_id
      OR NEW.recording_id IS DISTINCT FROM OLD.recording_id
    ) THEN
      RAISE EXCEPTION 'Catalog transfer recording identity is immutable.';
    END IF;
    IF TG_OP = 'DELETE' THEN
      SELECT item.transfer_id INTO target_transfer_id
      FROM music_catalog_transfer_items item
      WHERE item.id = OLD.transfer_item_id;
      target_recording_id := OLD.recording_id;
    ELSE
      SELECT item.transfer_id INTO target_transfer_id
      FROM music_catalog_transfer_items item
      WHERE item.id = NEW.transfer_item_id;
      target_recording_id := NEW.recording_id;
    END IF;
  END IF;

  SELECT transfer.status, transfer.performer_id, transfer.continuity_evidence_fingerprint
  INTO transfer_status, transfer_performer_id, transfer_continuity_fingerprint
  FROM music_catalog_transfers transfer
  WHERE transfer.id = target_transfer_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Catalog transfer evidence requires an existing transfer.';
  END IF;
  IF transfer_continuity_fingerprint IS NOT NULL OR transfer_status IN (
    'store_match_verified', 'artist_cutover_approved', 'old_provider_takedown',
    'cutover_monitoring', 'tail_royalty_reconciliation', 'complete'
  ) THEN
    RAISE EXCEPTION 'Catalog continuity evidence is sealed after store matching.';
  END IF;
  IF target_release_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM music_releases release
    WHERE release.id = target_release_id AND release.performer_id = transfer_performer_id
  ) THEN
    RAISE EXCEPTION 'Catalog transfer releases must belong to the transfer performer.';
  END IF;
  IF target_recording_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM music_recordings recording
    WHERE recording.id = target_recording_id AND recording.performer_id = transfer_performer_id
  ) THEN
    RAISE EXCEPTION 'Catalog transfer recordings must belong to the transfer performer.';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_record_catalog_transfer_transition"() RETURNS trigger AS $$
DECLARE
  actor_setting text;
  reason_setting text;
  metadata_setting text;
  transition_metadata jsonb;
BEGIN
  IF NEW.performer_id IS DISTINCT FROM OLD.performer_id
    OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
    OR NEW.source_distributor IS DISTINCT FROM OLD.source_distributor
    OR NEW.source_account_reference IS DISTINCT FROM OLD.source_account_reference THEN
    RAISE EXCEPTION 'Catalog transfer ownership and source identity are immutable.';
  END IF;

  IF OLD.status IN (
    'store_match_verified', 'artist_cutover_approved', 'old_provider_takedown',
    'cutover_monitoring', 'tail_royalty_reconciliation', 'complete'
  ) AND (
    NEW.performer_id IS DISTINCT FROM OLD.performer_id
    OR NEW.source_snapshot_asset_version_id IS DISTINCT FROM OLD.source_snapshot_asset_version_id
    OR NEW.expected_release_count IS DISTINCT FROM OLD.expected_release_count
    OR NEW.expected_recording_count IS DISTINCT FROM OLD.expected_recording_count
    OR NEW.known_limitations IS DISTINCT FROM OLD.known_limitations
    OR NEW.continuity_evidence_fingerprint IS DISTINCT FROM OLD.continuity_evidence_fingerprint
  ) THEN
    RAISE EXCEPTION 'Catalog continuity evidence is sealed after store matching.';
  END IF;

  IF OLD.continuity_evidence_fingerprint IS NOT NULL
    AND NEW.continuity_evidence_fingerprint IS DISTINCT FROM OLD.continuity_evidence_fingerprint THEN
    RAISE EXCEPTION 'The catalog continuity fingerprint is immutable once recorded.';
  END IF;
  IF OLD.continuity_evidence_fingerprint IS NOT NULL AND (
    NEW.source_snapshot_asset_version_id IS DISTINCT FROM OLD.source_snapshot_asset_version_id
    OR NEW.expected_release_count IS DISTINCT FROM OLD.expected_release_count
    OR NEW.expected_recording_count IS DISTINCT FROM OLD.expected_recording_count
    OR NEW.known_limitations IS DISTINCT FROM OLD.known_limitations
  ) THEN
    RAISE EXCEPTION 'Catalog continuity evidence remains sealed through all later holds and recovery.';
  END IF;
  IF OLD.artist_cutover_approved_at IS NOT NULL AND (
    NEW.artist_cutover_approved_by_user_id IS DISTINCT FROM OLD.artist_cutover_approved_by_user_id
    OR NEW.artist_cutover_approved_at IS DISTINCT FROM OLD.artist_cutover_approved_at
    OR NEW.artist_cutover_approval_fingerprint IS DISTINCT FROM OLD.artist_cutover_approval_fingerprint
  ) THEN
    RAISE EXCEPTION 'Recorded artist cutover approval is immutable.';
  END IF;
  IF OLD.old_provider_takedown_requested_at IS NOT NULL
    AND NEW.old_provider_takedown_requested_at IS DISTINCT FROM OLD.old_provider_takedown_requested_at THEN
    RAISE EXCEPTION 'The recorded old-provider takedown request is immutable.';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.continuity_evidence_fingerprint IS DISTINCT FROM OLD.continuity_evidence_fingerprint
      OR NEW.artist_cutover_approved_by_user_id IS DISTINCT FROM OLD.artist_cutover_approved_by_user_id
      OR NEW.artist_cutover_approved_at IS DISTINCT FROM OLD.artist_cutover_approved_at
      OR NEW.artist_cutover_approval_fingerprint IS DISTINCT FROM OLD.artist_cutover_approval_fingerprint
      OR NEW.old_provider_takedown_requested_at IS DISTINCT FROM OLD.old_provider_takedown_requested_at
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at THEN
      RAISE EXCEPTION 'Catalog evidence fields may be set only with their matching audited transition.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.continuity_evidence_fingerprint IS DISTINCT FROM OLD.continuity_evidence_fingerprint
    AND NEW.status <> 'store_match_verified' THEN
    RAISE EXCEPTION 'The continuity fingerprint may be set only when store matching is verified.';
  END IF;
  IF (
    NEW.artist_cutover_approved_by_user_id IS DISTINCT FROM OLD.artist_cutover_approved_by_user_id
    OR NEW.artist_cutover_approved_at IS DISTINCT FROM OLD.artist_cutover_approved_at
    OR NEW.artist_cutover_approval_fingerprint IS DISTINCT FROM OLD.artist_cutover_approval_fingerprint
  ) AND NEW.status <> 'artist_cutover_approved' THEN
    RAISE EXCEPTION 'Artist cutover approval may be recorded only with its audited transition.';
  END IF;
  IF NEW.old_provider_takedown_requested_at IS DISTINCT FROM OLD.old_provider_takedown_requested_at
    AND NEW.status <> 'old_provider_takedown' THEN
    RAISE EXCEPTION 'Old-provider takedown time may be recorded only with its audited transition.';
  END IF;
  IF NEW.completed_at IS DISTINCT FROM OLD.completed_at AND NEW.status <> 'complete' THEN
    RAISE EXCEPTION 'Transfer completion time may be recorded only with its audited transition.';
  END IF;

  IF NOT (
    (OLD.status = 'intake' AND NEW.status IN ('source_snapshot', 'canceled')) OR
    (OLD.status = 'source_snapshot' AND NEW.status IN ('rights_review', 'parity_failed', 'canceled')) OR
    (OLD.status = 'rights_review' AND NEW.status IN ('artist_identity_mapped', 'rights_blocked', 'canceled')) OR
    (OLD.status = 'artist_identity_mapped' AND NEW.status IN ('parity_locked', 'mapping_failed', 'parity_failed', 'canceled')) OR
    (OLD.status = 'parity_locked' AND NEW.status IN ('new_delivery_staged', 'parity_failed', 'rights_blocked', 'canceled')) OR
    (OLD.status = 'new_delivery_staged' AND NEW.status IN ('store_processing', 'parity_failed', 'content_id_conflict', 'canceled')) OR
    (OLD.status = 'store_processing' AND NEW.status IN ('overlap_live', 'track_link_failed', 'content_id_conflict', 'canceled')) OR
    (OLD.status = 'overlap_live' AND NEW.status IN ('store_match_verified', 'track_link_failed', 'content_id_conflict', 'canceled')) OR
    (OLD.status = 'store_match_verified' AND NEW.status IN ('artist_cutover_approved', 'track_link_failed', 'revenue_gap', 'canceled')) OR
    (OLD.status = 'artist_cutover_approved' AND NEW.status IN ('old_provider_takedown', 'track_link_failed', 'content_id_conflict', 'revenue_gap', 'canceled')) OR
    (OLD.status = 'old_provider_takedown' AND NEW.status IN ('cutover_monitoring', 'revenue_gap')) OR
    (OLD.status = 'cutover_monitoring' AND NEW.status IN ('tail_royalty_reconciliation', 'track_link_failed', 'content_id_conflict', 'revenue_gap')) OR
    (OLD.status = 'tail_royalty_reconciliation' AND NEW.status IN ('complete', 'revenue_gap')) OR
    (OLD.status = 'rights_blocked' AND NEW.status IN ('rights_review', 'canceled')) OR
    (OLD.status = 'parity_failed' AND NEW.status IN ('source_snapshot', 'rights_review', 'canceled')) OR
    (OLD.status = 'mapping_failed' AND NEW.status IN ('rights_review', 'artist_identity_mapped', 'canceled')) OR
    (OLD.status = 'track_link_failed' AND NEW.status IN ('store_processing', 'overlap_live', 'cutover_monitoring', 'canceled')) OR
    (OLD.status = 'content_id_conflict' AND NEW.status IN ('store_processing', 'overlap_live', 'cutover_monitoring', 'canceled')) OR
    (OLD.status = 'revenue_gap' AND NEW.status IN ('cutover_monitoring', 'tail_royalty_reconciliation', 'canceled'))
  ) THEN
    RAISE EXCEPTION 'Invalid catalog transfer transition from % to %.', OLD.status, NEW.status;
  END IF;

  IF NEW.status IN (
    'old_provider_takedown', 'cutover_monitoring', 'tail_royalty_reconciliation', 'complete'
  ) THEN
    RAISE EXCEPTION 'Catalog cutover execution is disabled until continuity is bound to immutable provider delivery evidence.';
  END IF;

  actor_setting := nullif(current_setting('sway.actor_user_id', true), '');
  reason_setting := nullif(current_setting('sway.transition_reason', true), '');
  metadata_setting := nullif(current_setting('sway.transition_metadata', true), '');

  IF actor_setting IS NULL OR reason_setting IS NULL THEN
    RAISE EXCEPTION 'Catalog transfer transitions require sway.actor_user_id and sway.transition_reason.';
  END IF;

  IF metadata_setting IS NOT NULL THEN
    transition_metadata := metadata_setting::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM performers performer
    JOIN users actor ON actor.id = actor_setting::uuid
    WHERE performer.id = NEW.performer_id
      AND (performer.owner_user_id = actor.id OR actor.role IN ('admin', 'support'))
  ) THEN
    RAISE EXCEPTION 'Catalog transfer transitions require the performer owner or an authorized operator.';
  END IF;

  IF OLD.status IN (
    'rights_blocked', 'parity_failed', 'mapping_failed', 'track_link_failed',
    'content_id_conflict', 'revenue_gap'
  ) AND NEW.status <> 'canceled' THEN
    IF transition_metadata->>'resolvedHoldState' IS DISTINCT FROM OLD.status::text
      OR COALESCE(transition_metadata->>'holdResolutionEvidenceFingerprint', '') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Catalog hold recovery requires a matching state and SHA-256 evidence fingerprint.';
    END IF;
  END IF;

  IF NEW.status = 'store_match_verified' THEN
    IF NEW.continuity_evidence_fingerprint IS NULL THEN
      RAISE EXCEPTION 'Store-match verification requires an immutable continuity evidence fingerprint.';
    END IF;
    IF NEW.expected_release_count IS NULL OR NEW.expected_recording_count IS NULL
      OR (SELECT count(*) FROM music_catalog_transfer_items item WHERE item.transfer_id = NEW.id) <> NEW.expected_release_count
      OR (
        SELECT count(*)
        FROM music_catalog_transfer_recordings recording
        JOIN music_catalog_transfer_items item ON item.id = recording.transfer_item_id
        WHERE item.transfer_id = NEW.id
      ) <> NEW.expected_recording_count THEN
      RAISE EXCEPTION 'Store-match verification requires complete, non-empty release and recording manifests.';
    END IF;
    IF EXISTS (
      SELECT 1 FROM music_catalog_transfer_items item
      WHERE item.transfer_id = NEW.id
        AND (item.parity_status <> 'matched'
          OR item.store_match_status NOT IN ('matched', 'known_unavoidable_loss')
          OR item.overlap_verified_at IS NULL
          OR item.store_continuity_report IS NULL
          OR (item.store_match_status = 'known_unavoidable_loss' AND jsonb_array_length(item.known_limitations) = 0))
    ) OR EXISTS (
      SELECT 1
      FROM music_catalog_transfer_recordings recording
      JOIN music_catalog_transfer_items item ON item.id = recording.transfer_item_id
      WHERE item.transfer_id = NEW.id
        AND (recording.parity_status <> 'matched'
          OR recording.store_match_status NOT IN ('matched', 'known_unavoidable_loss')
          OR recording.overlap_verified_at IS NULL
          OR recording.continuity_report IS NULL
          OR (recording.store_match_status = 'known_unavoidable_loss' AND jsonb_array_length(recording.known_limitations) = 0))
    ) THEN
      RAISE EXCEPTION 'Store-match verification requires verified release and recording continuity evidence.';
    END IF;
  END IF;

  IF NEW.status = 'artist_cutover_approved' THEN
    IF NEW.artist_cutover_approved_by_user_id IS NULL
      OR NEW.artist_cutover_approved_at IS NULL
      OR NEW.artist_cutover_approval_fingerprint IS NULL
      OR NEW.continuity_evidence_fingerprint IS NULL
      OR NEW.artist_cutover_approval_fingerprint <> NEW.continuity_evidence_fingerprint
      OR transition_metadata->>'artistCutoverApprovalFingerprint' IS DISTINCT FROM NEW.artist_cutover_approval_fingerprint
      OR transition_metadata->>'knownLimitationsDisclosed' IS DISTINCT FROM 'true'
      OR NOT EXISTS (
        SELECT 1 FROM performers performer
        WHERE performer.id = NEW.performer_id
          AND performer.owner_user_id = NEW.artist_cutover_approved_by_user_id
      ) THEN
      RAISE EXCEPTION 'Artist cutover approval must be owner-authenticated and bound to the disclosed continuity fingerprint.';
    END IF;
  END IF;

  IF NEW.status = 'old_provider_takedown' THEN
    IF NEW.artist_cutover_approved_by_user_id IS NULL
      OR NEW.artist_cutover_approved_at IS NULL
      OR NEW.artist_cutover_approval_fingerprint IS NULL
      OR NEW.artist_cutover_approval_fingerprint <> NEW.continuity_evidence_fingerprint
      OR NEW.old_provider_takedown_requested_at IS NULL
      OR transition_metadata->>'artistCutoverApprovalFingerprint' IS DISTINCT FROM NEW.artist_cutover_approval_fingerprint
      OR transition_metadata->>'unresolvedHoldCount' IS DISTINCT FROM '0' THEN
      RAISE EXCEPTION 'Old-provider takedown requires fingerprinted artist approval.';
    END IF;

    IF NEW.expected_release_count IS NULL OR NEW.expected_recording_count IS NULL
      OR (SELECT count(*) FROM music_catalog_transfer_items item WHERE item.transfer_id = NEW.id) <> NEW.expected_release_count
      OR (
        SELECT count(*)
        FROM music_catalog_transfer_recordings recording
        JOIN music_catalog_transfer_items item ON item.id = recording.transfer_item_id
        WHERE item.transfer_id = NEW.id
      ) <> NEW.expected_recording_count THEN
      RAISE EXCEPTION 'Old-provider takedown requires complete, non-empty release and recording manifests.';
    END IF;

    IF EXISTS (
      SELECT 1 FROM music_catalog_transfer_items item
      WHERE item.transfer_id = NEW.id
        AND (item.parity_status <> 'matched'
          OR item.store_match_status NOT IN ('matched', 'known_unavoidable_loss')
          OR item.overlap_verified_at IS NULL
          OR item.store_continuity_report IS NULL
          OR (item.store_match_status = 'known_unavoidable_loss' AND jsonb_array_length(item.known_limitations) = 0))
    ) OR EXISTS (
      SELECT 1
      FROM music_catalog_transfer_recordings recording
      JOIN music_catalog_transfer_items item ON item.id = recording.transfer_item_id
      WHERE item.transfer_id = NEW.id
        AND (recording.parity_status <> 'matched'
          OR recording.store_match_status NOT IN ('matched', 'known_unavoidable_loss')
          OR recording.overlap_verified_at IS NULL
          OR recording.continuity_report IS NULL
          OR (recording.store_match_status = 'known_unavoidable_loss' AND jsonb_array_length(recording.known_limitations) = 0))
    ) THEN
      RAISE EXCEPTION 'Old-provider takedown requires verified release and recording continuity.';
    END IF;
  END IF;

  IF NEW.status = 'complete' THEN
    IF NEW.completed_at IS NULL
      OR transition_metadata->>'tailRoyaltiesReconciled' IS DISTINCT FROM 'true'
      OR transition_metadata->>'unresolvedHoldCount' IS DISTINCT FROM '0' THEN
      RAISE EXCEPTION 'Transfer completion requires recorded tail-royalty reconciliation and zero unresolved holds.';
    END IF;
  END IF;

  NEW.updated_at := now();
  INSERT INTO music_catalog_transfer_events (
    transfer_id, actor_user_id, previous_status, next_status, reason, metadata
  ) VALUES (
    NEW.id, actor_setting::uuid, OLD.status, NEW.status, reason_setting, transition_metadata
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "audio_projects_authority" BEFORE INSERT ON "audio_projects" FOR EACH ROW EXECUTE FUNCTION "sway_validate_audio_project_insert"();
--> statement-breakpoint
CREATE TRIGGER "audio_project_access_grants_authority" BEFORE INSERT OR UPDATE ON "audio_project_access_grants" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_project_access_grant"();
--> statement-breakpoint
CREATE TRIGGER "audio_project_invitations_authority" BEFORE INSERT OR UPDATE ON "audio_project_invitations" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_project_invitation"();
--> statement-breakpoint
CREATE TRIGGER "audio_assets_authority" BEFORE INSERT ON "audio_assets" FOR EACH ROW EXECUTE FUNCTION "sway_validate_audio_asset_insert"();
--> statement-breakpoint
CREATE TRIGGER "audio_upload_sessions_state" BEFORE INSERT OR UPDATE ON "audio_upload_sessions" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_upload_session_state"();
--> statement-breakpoint
CREATE TRIGGER "audio_project_asset_versions_verified_seal" BEFORE INSERT ON "audio_project_asset_versions" FOR EACH ROW EXECUTE FUNCTION "sway_validate_audio_asset_version_seal"();
--> statement-breakpoint
CREATE TRIGGER "audio_file_pairing_tokens_state" BEFORE INSERT OR UPDATE ON "audio_file_pairing_tokens" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_file_pairing_token_state"();
--> statement-breakpoint
CREATE TRIGGER "audio_file_connections_state" BEFORE INSERT OR UPDATE ON "audio_file_connections" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_file_connection_state"();
--> statement-breakpoint
CREATE TRIGGER "audio_file_access_grants_authority" BEFORE INSERT ON "audio_file_access_grants" FOR EACH ROW EXECUTE FUNCTION "sway_validate_audio_file_access_grant"();
--> statement-breakpoint
CREATE TRIGGER "audio_file_access_grants_state" BEFORE UPDATE ON "audio_file_access_grants" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_file_access_grant_state"();
--> statement-breakpoint
CREATE TRIGGER "audio_file_connection_events_actor" BEFORE INSERT ON "audio_file_connection_events" FOR EACH ROW EXECUTE FUNCTION "sway_validate_audio_file_connection_event_actor"();
--> statement-breakpoint
CREATE TRIGGER "music_rights_declarations_authority" BEFORE INSERT ON "music_rights_declarations" FOR EACH ROW EXECUTE FUNCTION "sway_validate_rights_declaration"();
--> statement-breakpoint
CREATE TRIGGER "music_rights_declarations_initial_event" AFTER INSERT ON "music_rights_declarations" FOR EACH ROW EXECUTE FUNCTION "sway_record_rights_declaration_created"();
--> statement-breakpoint
CREATE TRIGGER "music_rights_declaration_events_state" BEFORE INSERT ON "music_rights_declaration_events" FOR EACH ROW EXECUTE FUNCTION "sway_validate_rights_declaration_event"();
--> statement-breakpoint
CREATE TRIGGER "audio_creator_deals_authority" BEFORE INSERT ON "audio_creator_deals" FOR EACH ROW EXECUTE FUNCTION "sway_validate_creator_deal"();
--> statement-breakpoint
CREATE TRIGGER "audio_creator_deals_initial_event" AFTER INSERT ON "audio_creator_deals" FOR EACH ROW EXECUTE FUNCTION "sway_record_creator_deal_proposed"();
--> statement-breakpoint
CREATE TRIGGER "audio_creator_deal_parties_seal" BEFORE INSERT ON "audio_creator_deal_parties" FOR EACH ROW EXECUTE FUNCTION "sway_validate_creator_deal_structure_insert"();
--> statement-breakpoint
CREATE TRIGGER "audio_creator_deal_allocations_seal" BEFORE INSERT ON "audio_creator_deal_allocations" FOR EACH ROW EXECUTE FUNCTION "sway_validate_creator_deal_structure_insert"();
--> statement-breakpoint
CREATE TRIGGER "audio_creator_deal_events_state" BEFORE INSERT ON "audio_creator_deal_events" FOR EACH ROW EXECUTE FUNCTION "sway_validate_creator_deal_event"();
--> statement-breakpoint
CREATE TRIGGER "music_distribution_deliveries_authority" BEFORE INSERT ON "music_distribution_deliveries" FOR EACH ROW EXECUTE FUNCTION "sway_validate_distribution_delivery_insert"();
--> statement-breakpoint
CREATE TRIGGER "music_distribution_deliveries_initial_event" AFTER INSERT ON "music_distribution_deliveries" FOR EACH ROW EXECUTE FUNCTION "sway_record_distribution_delivery_created"();
--> statement-breakpoint
CREATE TRIGGER "music_distribution_deliveries_transition_audit" BEFORE UPDATE ON "music_distribution_deliveries" FOR EACH ROW EXECUTE FUNCTION "sway_record_distribution_delivery_transition"();
--> statement-breakpoint
CREATE TRIGGER "music_distribution_delivery_events_state" BEFORE INSERT ON "music_distribution_delivery_events" FOR EACH ROW EXECUTE FUNCTION "sway_validate_distribution_delivery_event"();
--> statement-breakpoint
CREATE TRIGGER "music_catalog_transfers_intake" BEFORE INSERT ON "music_catalog_transfers" FOR EACH ROW EXECUTE FUNCTION "sway_validate_catalog_transfer_insert"();
--> statement-breakpoint
CREATE TRIGGER "music_catalog_transfer_items_scope" BEFORE INSERT OR UPDATE OR DELETE ON "music_catalog_transfer_items" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_catalog_transfer_child_scope"();
--> statement-breakpoint
CREATE TRIGGER "music_catalog_transfer_recordings_scope" BEFORE INSERT OR UPDATE OR DELETE ON "music_catalog_transfer_recordings" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_catalog_transfer_child_scope"();
--> statement-breakpoint
CREATE TRIGGER "music_catalog_transfers_transition_audit" BEFORE UPDATE OF "status", "performer_id", "created_by_user_id", "source_distributor", "source_account_reference", "source_snapshot_asset_version_id", "expected_release_count", "expected_recording_count", "known_limitations", "continuity_evidence_fingerprint", "artist_cutover_approved_by_user_id", "artist_cutover_approved_at", "artist_cutover_approval_fingerprint", "old_provider_takedown_requested_at", "completed_at" ON "music_catalog_transfers" FOR EACH ROW EXECUTE FUNCTION "sway_record_catalog_transfer_transition"();
--> statement-breakpoint
CREATE TRIGGER "audio_project_asset_versions_immutable" BEFORE UPDATE OR DELETE ON "audio_project_asset_versions" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audio_review_events_append_only" BEFORE UPDATE OR DELETE ON "audio_review_events" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audio_file_connection_events_append_only" BEFORE UPDATE OR DELETE ON "audio_file_connection_events" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "music_rights_declarations_immutable" BEFORE UPDATE OR DELETE ON "music_rights_declarations" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "music_rights_declaration_events_append_only" BEFORE UPDATE OR DELETE ON "music_rights_declaration_events" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audio_creator_deals_immutable" BEFORE UPDATE OR DELETE ON "audio_creator_deals" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audio_creator_deal_parties_immutable" BEFORE UPDATE OR DELETE ON "audio_creator_deal_parties" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audio_creator_deal_allocations_immutable" BEFORE UPDATE OR DELETE ON "audio_creator_deal_allocations" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "audio_creator_deal_events_append_only" BEFORE UPDATE OR DELETE ON "audio_creator_deal_events" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "music_distribution_delivery_events_append_only" BEFORE UPDATE OR DELETE ON "music_distribution_delivery_events" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE TRIGGER "music_catalog_transfer_events_append_only" BEFORE UPDATE OR DELETE ON "music_catalog_transfer_events" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
