CREATE TABLE "audio_provider_operation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"fencing_token" uuid NOT NULL,
	"mode" text NOT NULL,
	"lease_owner" text NOT NULL,
	"lease_started_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"request_fingerprint" text NOT NULL,
	"provider_started_at" timestamp with time zone,
	"provider_result_fingerprint" text,
	"error_code" text,
	"outcome" text DEFAULT 'active' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_provider_operation_attempts_mode_allowed" CHECK ("audio_provider_operation_attempts"."mode" in ('execute', 'reconcile')),
	CONSTRAINT "audio_provider_operation_attempts_lease_owner_required" CHECK (length(btrim("audio_provider_operation_attempts"."lease_owner")) between 1 and 160),
	CONSTRAINT "audio_provider_operation_attempts_lease_window_valid" CHECK ("audio_provider_operation_attempts"."lease_expires_at" > "audio_provider_operation_attempts"."lease_started_at"),
	CONSTRAINT "audio_provider_operation_attempts_request_fingerprint_valid" CHECK ("audio_provider_operation_attempts"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audio_provider_operation_attempts_result_fingerprint_valid" CHECK ("audio_provider_operation_attempts"."provider_result_fingerprint" is null or "audio_provider_operation_attempts"."provider_result_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audio_provider_operation_attempts_error_code_valid" CHECK ("audio_provider_operation_attempts"."error_code" is null or "audio_provider_operation_attempts"."error_code" ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
	CONSTRAINT "audio_provider_operation_attempts_outcome_allowed" CHECK ("audio_provider_operation_attempts"."outcome" in ('active', 'released', 'reconcile_required', 'awaiting_client_retry', 'succeeded', 'canceled', 'dead_letter', 'stale')),
	CONSTRAINT "audio_provider_operation_attempts_completion_coherent" CHECK (("audio_provider_operation_attempts"."outcome" = 'active' and "audio_provider_operation_attempts"."completed_at" is null) or ("audio_provider_operation_attempts"."outcome" <> 'active' and "audio_provider_operation_attempts"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "audio_provider_operation_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operation_id" uuid NOT NULL,
	"resolution_type" text NOT NULL,
	"upload_session_id" uuid,
	"resolved_by_user_id" uuid,
	"provider_observed_at" timestamp with time zone NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_provider_operation_resolutions_type_allowed" CHECK ("audio_provider_operation_resolutions"."resolution_type" in ('cleanup_confirmed', 'session_recovered')),
	CONSTRAINT "audio_provider_operation_resolutions_evidence_fingerprint_valid" CHECK ("audio_provider_operation_resolutions"."evidence_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audio_provider_operation_resolutions_evidence_required" CHECK (jsonb_typeof("audio_provider_operation_resolutions"."evidence") = 'object' and "audio_provider_operation_resolutions"."evidence" <> '{}'::jsonb),
	CONSTRAINT "audio_provider_operation_resolutions_session_coherent" CHECK (("audio_provider_operation_resolutions"."resolution_type" = 'cleanup_confirmed' and "audio_provider_operation_resolutions"."upload_session_id" is null) or ("audio_provider_operation_resolutions"."resolution_type" = 'session_recovered' and "audio_provider_operation_resolutions"."upload_session_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "audio_provider_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"requested_by_user_id" uuid,
	"upload_session_id" uuid,
	"planned_upload_session_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"operation_key" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"request_origin" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"provider_upload_id" text,
	"part_number" integer,
	"body_sha256" text,
	"body_md5" text,
	"body_byte_size" bigint,
	"reserved_byte_size" bigint DEFAULT 0 NOT NULL,
	"reserved_object_count" integer DEFAULT 0 NOT NULL,
	"request_payload" jsonb NOT NULL,
	"result_payload" jsonb,
	"result_fingerprint" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 20 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_owner" text,
	"lease_mode" text,
	"lease_expires_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"last_error_code" text,
	"provider_started_at" timestamp with time zone,
	"provider_confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audio_provider_operations_type_allowed" CHECK ("audio_provider_operations"."operation_type" in ('initiate_multipart', 'upload_part', 'complete_multipart', 'discard_upload', 'abort_upload')),
	CONSTRAINT "audio_provider_operations_status_allowed" CHECK ("audio_provider_operations"."status" in ('pending', 'leased', 'reconcile_required', 'awaiting_client_retry', 'succeeded', 'canceled', 'dead_letter')),
	CONSTRAINT "audio_provider_operations_key_required" CHECK ("audio_provider_operations"."operation_key" = 'audio-provider:v1:' || "audio_provider_operations"."project_id"::text || ':' || "audio_provider_operations"."planned_upload_session_id"::text || ':' || "audio_provider_operations"."operation_type" || ':' || coalesce("audio_provider_operations"."part_number"::text, '0')),
	CONSTRAINT "audio_provider_operations_request_origin_coherent" CHECK (("audio_provider_operations"."request_origin" = 'user' and "audio_provider_operations"."requested_by_user_id" is not null) or ("audio_provider_operations"."request_origin" in ('system_cleanup', 'system_recovery') and "audio_provider_operations"."requested_by_user_id" is null)),
	CONSTRAINT "audio_provider_operations_storage_identity_required" CHECK (length(btrim("audio_provider_operations"."storage_provider")) between 1 and 80 and length(btrim("audio_provider_operations"."storage_bucket")) between 1 and 240 and length(btrim("audio_provider_operations"."storage_key")) between 1 and 1024 and ("audio_provider_operations"."provider_upload_id" is null or length(btrim("audio_provider_operations"."provider_upload_id")) between 1 and 1024)),
	CONSTRAINT "audio_provider_operations_intent_fingerprint_valid" CHECK ("audio_provider_operations"."intent_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audio_provider_operations_request_payload_valid" CHECK (jsonb_typeof("audio_provider_operations"."request_payload") = 'object' and "audio_provider_operations"."request_payload" <> '{}'::jsonb),
	CONSTRAINT "audio_provider_operations_result_evidence_valid" CHECK (("audio_provider_operations"."result_payload" is null and "audio_provider_operations"."result_fingerprint" is null) or ("audio_provider_operations"."result_payload" is not null and jsonb_typeof("audio_provider_operations"."result_payload") = 'object' and "audio_provider_operations"."result_payload" <> '{}'::jsonb and "audio_provider_operations"."result_fingerprint" is not null and "audio_provider_operations"."result_fingerprint" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "audio_provider_operations_attempts_valid" CHECK ("audio_provider_operations"."attempt_count" >= 0 and "audio_provider_operations"."max_attempts" between 1 and 100 and "audio_provider_operations"."attempt_count" <= "audio_provider_operations"."max_attempts"),
	CONSTRAINT "audio_provider_operations_reservation_valid" CHECK (("audio_provider_operations"."operation_type" = 'initiate_multipart' and "audio_provider_operations"."reserved_byte_size" > 0 and "audio_provider_operations"."reserved_object_count" = 1 and "audio_provider_operations"."request_payload" ? 'expectedByteSize' and jsonb_typeof("audio_provider_operations"."request_payload"->'expectedByteSize') = 'number' and coalesce("audio_provider_operations"."request_payload"->>'expectedByteSize' ~ '^[1-9][0-9]*$', false) and ("audio_provider_operations"."request_payload"->>'expectedByteSize')::numeric = "audio_provider_operations"."reserved_byte_size") or ("audio_provider_operations"."operation_type" <> 'initiate_multipart' and "audio_provider_operations"."reserved_byte_size" = 0 and "audio_provider_operations"."reserved_object_count" = 0)),
	CONSTRAINT "audio_provider_operations_upload_session_coherent" CHECK ("audio_provider_operations"."upload_session_id" is null or "audio_provider_operations"."upload_session_id" = "audio_provider_operations"."planned_upload_session_id"),
	CONSTRAINT "audio_provider_operations_session_required" CHECK ("audio_provider_operations"."operation_type" = 'initiate_multipart' or "audio_provider_operations"."upload_session_id" is not null),
	CONSTRAINT "audio_provider_operations_part_shape" CHECK (("audio_provider_operations"."operation_type" = 'upload_part' and "audio_provider_operations"."part_number" is not null and "audio_provider_operations"."part_number" between 1 and 10000 and "audio_provider_operations"."body_sha256" is not null and "audio_provider_operations"."body_sha256" ~ '^[0-9a-f]{64}$' and "audio_provider_operations"."body_md5" is not null and "audio_provider_operations"."body_md5" ~ '^[0-9a-f]{32}$' and "audio_provider_operations"."body_byte_size" is not null and "audio_provider_operations"."body_byte_size" > 0) or ("audio_provider_operations"."operation_type" <> 'upload_part' and "audio_provider_operations"."part_number" is null and "audio_provider_operations"."body_sha256" is null and "audio_provider_operations"."body_md5" is null and "audio_provider_operations"."body_byte_size" is null)),
	CONSTRAINT "audio_provider_operations_provider_identity_shape" CHECK (("audio_provider_operations"."operation_type" = 'initiate_multipart' and ("audio_provider_operations"."provider_upload_id" is null or "audio_provider_operations"."provider_started_at" is not null)) or ("audio_provider_operations"."operation_type" <> 'initiate_multipart' and "audio_provider_operations"."provider_upload_id" is not null)),
	CONSTRAINT "audio_provider_operations_lease_coherent" CHECK (("audio_provider_operations"."status" = 'leased' and "audio_provider_operations"."lease_token" is not null and "audio_provider_operations"."lease_owner" is not null and length(btrim("audio_provider_operations"."lease_owner")) > 0 and "audio_provider_operations"."lease_mode" in ('execute', 'reconcile') and "audio_provider_operations"."lease_expires_at" is not null) or ("audio_provider_operations"."status" <> 'leased' and "audio_provider_operations"."lease_token" is null and "audio_provider_operations"."lease_owner" is null and "audio_provider_operations"."lease_mode" is null and "audio_provider_operations"."lease_expires_at" is null)),
	CONSTRAINT "audio_provider_operations_error_code_valid" CHECK ("audio_provider_operations"."last_error_code" is null or "audio_provider_operations"."last_error_code" ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
	CONSTRAINT "audio_provider_operations_completion_coherent" CHECK (("audio_provider_operations"."status" in ('succeeded', 'canceled') and "audio_provider_operations"."completed_at" is not null) or ("audio_provider_operations"."status" not in ('succeeded', 'canceled') and "audio_provider_operations"."completed_at" is null)),
	CONSTRAINT "audio_provider_operations_provider_confirmation_coherent" CHECK ("audio_provider_operations"."provider_confirmed_at" is null or ("audio_provider_operations"."provider_started_at" is not null and "audio_provider_operations"."result_payload" is not null))
);
--> statement-breakpoint
ALTER TABLE "audio_provider_operation_attempts" ADD CONSTRAINT "audio_provider_operation_attempts_operation_id_audio_provider_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."audio_provider_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_provider_operation_resolutions" ADD CONSTRAINT "audio_provider_operation_resolutions_operation_id_audio_provider_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."audio_provider_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_provider_operation_resolutions" ADD CONSTRAINT "audio_provider_operation_resolutions_upload_session_id_audio_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."audio_upload_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_provider_operation_resolutions" ADD CONSTRAINT "audio_provider_operation_resolutions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_provider_operations" ADD CONSTRAINT "audio_provider_operations_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."audio_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_provider_operations" ADD CONSTRAINT "audio_provider_operations_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_provider_operations" ADD CONSTRAINT "audio_provider_operations_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_provider_operations" ADD CONSTRAINT "audio_provider_operations_upload_session_id_audio_upload_sessions_id_fk" FOREIGN KEY ("upload_session_id") REFERENCES "public"."audio_upload_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_provider_operations" ADD CONSTRAINT "audio_provider_operations_project_performer_fk" FOREIGN KEY ("project_id","performer_id") REFERENCES "public"."audio_projects"("id","performer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_provider_operation_attempts_operation_attempt_idx" ON "audio_provider_operation_attempts" USING btree ("operation_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_provider_operation_attempts_fencing_token_idx" ON "audio_provider_operation_attempts" USING btree ("fencing_token");--> statement-breakpoint
CREATE INDEX "audio_provider_operation_attempts_outcome_idx" ON "audio_provider_operation_attempts" USING btree ("outcome","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_provider_operation_resolutions_operation_idx" ON "audio_provider_operation_resolutions" USING btree ("operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_provider_operations_operation_key_idx" ON "audio_provider_operations" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "audio_provider_operations_subject_operation_idx" ON "audio_provider_operations" USING btree ("planned_upload_session_id","operation_type",coalesce("part_number", 0));--> statement-breakpoint
CREATE INDEX "audio_provider_operations_claim_idx" ON "audio_provider_operations" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "audio_provider_operations_project_status_idx" ON "audio_provider_operations" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "audio_provider_operations_performer_reservation_idx" ON "audio_provider_operations" USING btree ("performer_id","status");--> statement-breakpoint
CREATE INDEX "audio_provider_operations_upload_session_idx" ON "audio_provider_operations" USING btree ("upload_session_id");
--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" DROP CONSTRAINT "audio_upload_sessions_collaborator_purpose_coherent";
--> statement-breakpoint
ALTER TABLE "audio_upload_sessions" ADD CONSTRAINT "audio_upload_sessions_collaborator_purpose_coherent" CHECK (("audio_upload_sessions"."upload_purpose" = 'owner_asset' and "audio_upload_sessions"."collaborator_file_grant_id" is null and "audio_upload_sessions"."source_asset_version_id" is null and ("audio_upload_sessions"."request_fingerprint" is null or "audio_upload_sessions"."request_fingerprint" ~ '^[0-9a-f]{64}$')) or ("audio_upload_sessions"."upload_purpose" = 'collaborator_revision' and "audio_upload_sessions"."collaborator_file_grant_id" is not null and "audio_upload_sessions"."source_asset_version_id" is not null and "audio_upload_sessions"."request_fingerprint" ~ '^[0-9a-f]{64}$'));
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_provider_attempt_state"() RETURNS trigger AS $$
DECLARE
  operation_record audio_provider_operations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Audio provider operation attempts are durable evidence and cannot be deleted.';
  END IF;
  IF pg_trigger_depth() <> 2 THEN
    RAISE EXCEPTION 'Audio provider operation attempts are internal durable evidence and may only be changed by provider-operation transitions.';
  END IF;

  SELECT * INTO operation_record
  FROM audio_provider_operations
  WHERE id = NEW.operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Audio provider attempt requires an existing operation.';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.outcome <> 'active'
      OR NEW.provider_started_at IS NOT NULL
      OR NEW.provider_result_fingerprint IS NOT NULL
      OR NEW.error_code IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.attempt_number <> operation_record.attempt_count + 1
      OR NEW.request_fingerprint IS DISTINCT FROM operation_record.intent_fingerprint THEN
      RAISE EXCEPTION 'Audio provider attempts must begin as the next untouched active lease generation.';
    END IF;
    IF NEW.fencing_token IS NULL
      OR NEW.lease_expires_at <= clock_timestamp()
      OR NEW.lease_expires_at > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'Audio provider attempt leases must be active and bounded to five minutes.';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.attempt_number IS DISTINCT FROM OLD.attempt_number
    OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
    OR NEW.mode IS DISTINCT FROM OLD.mode
    OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
    OR NEW.lease_started_at IS DISTINCT FROM OLD.lease_started_at
    OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Audio provider attempt identity and fencing generation are immutable.';
  END IF;
  IF OLD.outcome <> 'active' THEN
    RAISE EXCEPTION 'Finalized audio provider attempts cannot be changed.';
  END IF;
  IF operation_record.status <> 'leased'
    OR operation_record.lease_token IS DISTINCT FROM OLD.fencing_token
    OR (
      operation_record.lease_expires_at <= clock_timestamp()
      AND NOT (
        (
          NEW.outcome = 'stale'
          AND OLD.outcome = 'active'
          AND NEW.provider_started_at IS NOT DISTINCT FROM OLD.provider_started_at
          AND NEW.provider_result_fingerprint IS NOT DISTINCT FROM OLD.provider_result_fingerprint
        )
        OR (
          NEW.outcome = 'canceled'
          AND OLD.outcome = 'active'
        )
        OR (
          NEW.outcome = 'dead_letter'
          AND operation_record.attempt_count >= operation_record.max_attempts
        )
      )
    ) THEN
    RAISE EXCEPTION 'A stale provider attempt cannot mutate after its operation lease expires or changes.';
  END IF;
  IF NEW.lease_expires_at < OLD.lease_expires_at
    OR NEW.lease_expires_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Audio provider attempt lease extension must remain active and bounded.';
  END IF;

  IF NEW.provider_started_at IS DISTINCT FROM OLD.provider_started_at THEN
    IF OLD.provider_started_at IS NOT NULL
      OR NEW.provider_started_at IS NULL
      OR OLD.mode <> 'execute' THEN
      RAISE EXCEPTION 'Provider dispatch evidence may be recorded once on an active execute attempt.';
    END IF;
    NEW.provider_started_at := clock_timestamp();
  END IF;
  IF NEW.provider_result_fingerprint IS DISTINCT FROM OLD.provider_result_fingerprint THEN
    IF OLD.provider_result_fingerprint IS NOT NULL
      OR NEW.provider_result_fingerprint IS NULL THEN
      RAISE EXCEPTION 'Provider result evidence may be recorded once per attempt.';
    END IF;
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    IF NEW.outcome = 'active' OR NEW.completed_at IS NULL THEN
      RAISE EXCEPTION 'Provider attempts may finalize once with a completion timestamp.';
    END IF;
    NEW.completed_at := clock_timestamp();
  ELSIF NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.error_code IS DISTINCT FROM OLD.error_code THEN
    RAISE EXCEPTION 'Provider attempt completion evidence changes only during finalization.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_provider_operation_state"() RETURNS trigger AS $$
DECLARE
  upload_record audio_upload_sessions%ROWTYPE;
  expected_lease_mode text;
  lease_acquired boolean;
  result_changed boolean;
  attempt_outcome text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Audio provider operations are durable evidence and cannot be deleted.';
  END IF;

  IF NEW.upload_session_id IS NOT NULL THEN
    SELECT * INTO upload_record
    FROM audio_upload_sessions
    WHERE id = NEW.upload_session_id;

    IF NOT FOUND
      OR upload_record.id IS DISTINCT FROM NEW.planned_upload_session_id
      OR upload_record.project_id IS DISTINCT FROM NEW.project_id
      OR upload_record.storage_provider IS DISTINCT FROM NEW.storage_provider
      OR upload_record.storage_bucket IS DISTINCT FROM NEW.storage_bucket
      OR upload_record.storage_key IS DISTINCT FROM NEW.storage_key
      OR upload_record.provider_upload_id IS DISTINCT FROM NEW.provider_upload_id THEN
      RAISE EXCEPTION 'Audio provider operation session identity does not match its durable intent.';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
      OR NEW.attempt_count <> 0
      OR NEW.lease_token IS NOT NULL
      OR NEW.lease_owner IS NOT NULL
      OR NEW.lease_mode IS NOT NULL
      OR NEW.lease_expires_at IS NOT NULL
      OR NEW.last_attempt_at IS NOT NULL
      OR NEW.last_error IS NOT NULL
      OR NEW.last_error_code IS NOT NULL
      OR NEW.provider_started_at IS NOT NULL
      OR NEW.provider_confirmed_at IS NOT NULL
      OR NEW.completed_at IS NOT NULL
      OR NEW.result_payload IS NOT NULL
      OR NEW.result_fingerprint IS NOT NULL THEN
      RAISE EXCEPTION 'Audio provider operations must begin as untouched pending intent.';
    END IF;
    IF NEW.operation_type = 'initiate_multipart'
      AND (NEW.upload_session_id IS NOT NULL OR NEW.provider_upload_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Multipart initiation intent must be reserved before a provider upload or session exists.';
    END IF;
    IF NEW.request_origin = 'user' AND NOT (
      EXISTS (
        SELECT 1
        FROM audio_project_access_grants authority
        WHERE authority.project_id = NEW.project_id
          AND authority.grantee_user_id = NEW.requested_by_user_id
          AND authority.can_upload_versions = true
          AND authority.revoked_at IS NULL
          AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
      )
      OR EXISTS (
        SELECT 1
        FROM audio_file_access_grants authority
        WHERE authority.id = (NEW.request_payload->>'collaboratorFileGrantId')::uuid
          AND authority.project_id = NEW.project_id
          AND authority.grantee_user_id = NEW.requested_by_user_id
          AND authority.grant_purpose = 'collaborator_revision_upload'
          AND authority.can_upload_new_version = true
          AND authority.revoked_at IS NULL
          AND authority.expires_at > clock_timestamp()
      )
    ) THEN
      RAISE EXCEPTION 'User-origin provider operations require active project upload authority.';
    END IF;
    IF NEW.request_origin = 'system_cleanup'
      AND NEW.operation_type NOT IN ('discard_upload', 'abort_upload') THEN
      RAISE EXCEPTION 'System cleanup origin is limited to discard and abort operations.';
    END IF;
    IF NEW.request_origin = 'system_recovery'
      AND (NEW.operation_type = 'initiate_multipart' OR NEW.upload_session_id IS NULL) THEN
      RAISE EXCEPTION 'System recovery cannot create fresh multipart initiation intent and must remain bound to an existing upload session.';
    END IF;
    IF NEW.request_origin = 'user' AND NEW.upload_session_id IS NOT NULL THEN
      IF upload_record.initiated_by_user_id IS DISTINCT FROM NEW.requested_by_user_id THEN
        RAISE EXCEPTION 'User-origin provider operations must match the exact upload-session actor.';
      END IF;
      IF upload_record.upload_purpose = 'collaborator_revision' THEN
        IF NOT coalesce(
          NEW.request_payload->>'collaboratorFileGrantId'
            = upload_record.collaborator_file_grant_id::text,
          false
        ) THEN
          RAISE EXCEPTION 'Collaborator provider operations require the exact session file grant.';
        END IF;
        PERFORM sway_require_active_collaborator_revision_grant(
          upload_record.collaborator_file_grant_id,
          upload_record.project_id,
          upload_record.initiated_by_user_id,
          upload_record.asset_id,
          upload_record.source_asset_version_id
        );
      END IF;
    END IF;
    IF NEW.operation_type = 'initiate_multipart'
      AND current_setting('sway.audio_storage_performer_transaction', true)
        IS DISTINCT FROM NEW.performer_id::text THEN
      RAISE EXCEPTION 'Multipart initiation reservation requires a marked performer storage transaction.';
    END IF;
    NEW.updated_at := NEW.created_at;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.project_id IS DISTINCT FROM OLD.project_id
    OR NEW.performer_id IS DISTINCT FROM OLD.performer_id
    OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
    OR NEW.planned_upload_session_id IS DISTINCT FROM OLD.planned_upload_session_id
    OR NEW.operation_type IS DISTINCT FROM OLD.operation_type
    OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
    OR NEW.intent_fingerprint IS DISTINCT FROM OLD.intent_fingerprint
    OR NEW.request_origin IS DISTINCT FROM OLD.request_origin
    OR NEW.storage_provider IS DISTINCT FROM OLD.storage_provider
    OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
    OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
    OR NEW.part_number IS DISTINCT FROM OLD.part_number
    OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256
    OR NEW.body_md5 IS DISTINCT FROM OLD.body_md5
    OR NEW.body_byte_size IS DISTINCT FROM OLD.body_byte_size
    OR NEW.reserved_byte_size IS DISTINCT FROM OLD.reserved_byte_size
    OR NEW.reserved_object_count IS DISTINCT FROM OLD.reserved_object_count
    OR NEW.request_payload IS DISTINCT FROM OLD.request_payload
    OR NEW.max_attempts IS DISTINCT FROM OLD.max_attempts
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Audio provider operation intent identity is immutable.';
  END IF;

  IF OLD.status IN ('succeeded', 'canceled', 'dead_letter') THEN
    RAISE EXCEPTION 'Terminal audio provider operations cannot be changed.';
  END IF;

  lease_acquired := NEW.status = 'leased'
    AND (OLD.status <> 'leased' OR NEW.lease_token IS DISTINCT FROM OLD.lease_token);
  result_changed := NEW.result_payload IS DISTINCT FROM OLD.result_payload
    OR NEW.result_fingerprint IS DISTINCT FROM OLD.result_fingerprint;

  IF OLD.status = 'leased'
    AND OLD.lease_expires_at <= clock_timestamp()
    AND NOT lease_acquired
    AND NOT (
      NEW.status = 'dead_letter'
      AND OLD.attempt_count >= OLD.max_attempts
      AND NEW.attempt_count = OLD.attempt_count
      AND NEW.lease_token IS NULL
      AND NEW.lease_owner IS NULL
      AND NEW.lease_mode IS NULL
      AND NEW.lease_expires_at IS NULL
    )
    AND NOT (
      NEW.status = 'canceled'
      AND NEW.lease_token IS NULL
      AND NEW.lease_owner IS NULL
      AND NEW.lease_mode IS NULL
      AND NEW.lease_expires_at IS NULL
      AND (
        coalesce(NEW.result_payload->>'providerNotStarted' = 'true', false)
        OR (
          coalesce(NEW.result_payload->>'cleanupConfirmed' = 'true', false)
          AND coalesce(NEW.result_payload->>'reconciledAbsent' = 'true', false)
        )
      )
    ) THEN
    RAISE EXCEPTION 'Expired audio provider operation leases are fenced from renewal, dispatch, confirmation, or finalization.';
  END IF;

  IF NEW.upload_session_id IS DISTINCT FROM OLD.upload_session_id THEN
    IF OLD.upload_session_id IS NOT NULL
      OR NEW.upload_session_id IS DISTINCT FROM NEW.planned_upload_session_id
      OR NEW.operation_type <> 'initiate_multipart'
      OR OLD.status <> 'leased'
      OR NEW.status <> 'succeeded' THEN
      RAISE EXCEPTION 'Audio provider operation session may be linked only while completing its initiation intent.';
    END IF;
  END IF;

  IF NEW.provider_upload_id IS DISTINCT FROM OLD.provider_upload_id THEN
    IF OLD.provider_upload_id IS NOT NULL
      OR NEW.provider_upload_id IS NULL
      OR NEW.operation_type <> 'initiate_multipart'
      OR OLD.status <> 'leased'
      OR OLD.lease_expires_at <= clock_timestamp()
      OR OLD.provider_started_at IS NULL
      OR NEW.status NOT IN ('leased', 'succeeded', 'canceled') THEN
      RAISE EXCEPTION 'Audio provider upload identity may be recorded once after active leased initiation dispatch.';
    END IF;
  END IF;

  IF NEW.provider_started_at IS DISTINCT FROM OLD.provider_started_at THEN
    IF OLD.provider_started_at IS NULL AND NEW.provider_started_at IS NOT NULL THEN
      IF OLD.status <> 'leased'
        OR NEW.status <> 'leased'
        OR OLD.lease_mode <> 'execute'
        OR OLD.lease_expires_at <= clock_timestamp()
        OR NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
        RAISE EXCEPTION 'Provider-start evidence requires an active execute lease before provider I/O.';
      END IF;
      NEW.provider_started_at := clock_timestamp();
      UPDATE audio_provider_operation_attempts
      SET provider_started_at = NEW.provider_started_at
      WHERE operation_id = OLD.id
        AND attempt_number = OLD.attempt_count
        AND fencing_token = OLD.lease_token;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Provider-start evidence requires the matching durable attempt generation.';
      END IF;
    ELSIF OLD.provider_started_at IS NOT NULL AND NEW.provider_started_at IS NULL THEN
      IF OLD.status <> 'leased'
        OR OLD.lease_mode <> 'reconcile'
        OR OLD.lease_expires_at <= clock_timestamp()
        OR NEW.provider_confirmed_at IS NOT NULL
        OR NOT (
          (
            OLD.operation_type = 'initiate_multipart'
            AND NEW.status = 'pending'
            AND OLD.provider_upload_id IS NULL
            AND coalesce(NEW.result_payload->>'reconciledAbsent' = 'true', false)
          )
          OR (
            OLD.operation_type <> 'initiate_multipart'
            AND NEW.status IN ('pending', 'awaiting_client_retry')
            AND coalesce(NEW.result_payload->>'reconciledSafeToRetry' = 'true', false)
          )
        )
        OR NEW.result_fingerprint IS NULL THEN
        RAISE EXCEPTION 'Provider-start evidence may reset only after exact reconciliation proves a retry safe.';
      END IF;
    ELSE
      RAISE EXCEPTION 'Provider-start evidence is monotonic outside exact absent reconciliation.';
    END IF;
  END IF;

  IF OLD.provider_confirmed_at IS NOT NULL
    AND (NEW.provider_confirmed_at IS DISTINCT FROM OLD.provider_confirmed_at OR result_changed) THEN
    RAISE EXCEPTION 'Confirmed provider result evidence is immutable.';
  END IF;
  IF NEW.provider_confirmed_at IS DISTINCT FROM OLD.provider_confirmed_at THEN
    IF OLD.provider_confirmed_at IS NOT NULL
      OR NEW.provider_confirmed_at IS NULL
      OR NEW.status NOT IN ('leased', 'succeeded', 'canceled')
      OR NOT result_changed
      OR NEW.result_payload IS NULL
      OR NEW.result_fingerprint IS NULL
      OR NOT (
        (
          OLD.status = 'leased'
          AND OLD.lease_expires_at > clock_timestamp()
        )
        OR (
          NEW.status = 'canceled'
          AND coalesce(NEW.result_payload->>'cleanupConfirmed' = 'true', false)
          AND coalesce(NEW.result_payload->>'reconciledAbsent' = 'true', false)
        )
      ) THEN
      RAISE EXCEPTION 'Provider confirmation and result fingerprint must be recorded atomically under an active lease.';
    END IF;
    NEW.provider_confirmed_at := clock_timestamp();
  END IF;
  IF result_changed AND NOT (
    (OLD.status = 'leased' AND OLD.lease_expires_at > clock_timestamp())
    OR NEW.status = 'canceled'
  ) THEN
    RAISE EXCEPTION 'Provider result evidence changes only under an active lease or proven pre-start cancellation.';
  END IF;

  IF NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION 'Audio provider operation attempt count cannot move backwards.';
  END IF;

  IF lease_acquired THEN
    NEW.last_attempt_at := clock_timestamp();
    expected_lease_mode := CASE
      WHEN OLD.status = 'reconcile_required' THEN 'reconcile'
      WHEN OLD.status = 'leased' AND OLD.provider_started_at IS NOT NULL THEN 'reconcile'
      ELSE 'execute'
    END;
    IF NOT (
      OLD.status IN ('pending', 'reconcile_required', 'awaiting_client_retry')
      OR (OLD.status = 'leased' AND OLD.lease_expires_at <= clock_timestamp())
    )
      OR NEW.lease_token IS NULL
      OR (OLD.status = 'leased' AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token)
      OR NEW.lease_mode IS DISTINCT FROM expected_lease_mode
      OR NEW.attempt_count <> OLD.attempt_count + 1
      OR (OLD.last_attempt_at IS NOT NULL AND NEW.last_attempt_at <= OLD.last_attempt_at)
      OR OLD.available_at > clock_timestamp()
      OR NEW.lease_expires_at <= clock_timestamp()
      OR NEW.lease_expires_at > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'Audio provider operation lease acquisition must be available, fresh, fenced, mode-safe, and bounded.';
    END IF;
    IF OLD.status = 'leased' THEN
      UPDATE audio_provider_operation_attempts
      SET outcome = 'stale',
          error_code = 'lease_expired',
          completed_at = clock_timestamp()
      WHERE operation_id = OLD.id
        AND attempt_number = OLD.attempt_count
        AND fencing_token = OLD.lease_token;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Expired lease takeover requires the prior durable attempt generation.';
      END IF;
    END IF;
    INSERT INTO audio_provider_operation_attempts (
      operation_id,
      attempt_number,
      fencing_token,
      mode,
      lease_owner,
      lease_started_at,
      lease_expires_at,
      request_fingerprint
    ) VALUES (
      OLD.id,
      NEW.attempt_count,
      NEW.lease_token,
      NEW.lease_mode,
      NEW.lease_owner,
      NEW.last_attempt_at,
      NEW.lease_expires_at,
      OLD.intent_fingerprint
    );
  ELSIF OLD.status = 'leased' AND NEW.status = 'leased' THEN
    IF OLD.lease_expires_at <= clock_timestamp()
      OR NEW.lease_token IS DISTINCT FROM OLD.lease_token
      OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner
      OR NEW.lease_mode IS DISTINCT FROM OLD.lease_mode
      OR NEW.attempt_count <> OLD.attempt_count
      OR NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at
      OR NEW.lease_expires_at < OLD.lease_expires_at
      OR NEW.lease_expires_at > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'Only the active holder may extend an unexpired bounded provider-operation lease.';
    END IF;
    IF NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at THEN
      UPDATE audio_provider_operation_attempts
      SET lease_expires_at = NEW.lease_expires_at
      WHERE operation_id = OLD.id
        AND attempt_number = OLD.attempt_count
        AND fencing_token = OLD.lease_token;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Lease extension requires the matching durable attempt generation.';
      END IF;
    END IF;
  ELSIF NEW.attempt_count <> OLD.attempt_count
    OR NEW.last_attempt_at IS DISTINCT FROM OLD.last_attempt_at THEN
    RAISE EXCEPTION 'Audio provider operation attempts advance only when a fresh lease is acquired.';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('leased', 'canceled', 'dead_letter')) OR
    (OLD.status = 'leased' AND NEW.status IN ('pending', 'reconcile_required', 'awaiting_client_retry', 'succeeded', 'canceled', 'dead_letter')) OR
    (OLD.status = 'reconcile_required' AND NEW.status IN ('leased', 'canceled', 'dead_letter')) OR
    (OLD.status = 'awaiting_client_retry' AND NEW.status IN ('leased', 'canceled', 'dead_letter'))
  ) THEN
    RAISE EXCEPTION 'Invalid audio provider operation transition from % to %.', OLD.status, NEW.status;
  END IF;

  IF NEW.status = 'pending' AND NEW.provider_started_at IS NOT NULL THEN
    RAISE EXCEPTION 'Ambiguous provider I/O must reconcile before retry and cannot return to pending.';
  END IF;
  IF NEW.status = 'reconcile_required'
    AND (NEW.provider_started_at IS NULL OR NEW.provider_confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Reconciliation is required only for started, unconfirmed provider I/O.';
  END IF;
  IF NEW.status = 'awaiting_client_retry'
    AND (NEW.operation_type <> 'upload_part' OR NEW.provider_started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Only reconciled, provider-safe upload-part operations may await a replayed client body.';
  END IF;
  IF NEW.status = 'succeeded'
    AND (NEW.provider_started_at IS NULL OR NEW.provider_confirmed_at IS NULL
      OR NEW.result_payload IS NULL OR NEW.result_fingerprint IS NULL) THEN
    RAISE EXCEPTION 'Successful audio provider operations require start and provider-confirmation evidence.';
  END IF;
  IF NEW.status = 'succeeded' AND NEW.operation_type = 'initiate_multipart' THEN
    IF NEW.upload_session_id IS NULL
      OR NEW.provider_upload_id IS NULL
      OR upload_record.expected_byte_size IS DISTINCT FROM NEW.reserved_byte_size
      OR upload_record.upload_status <> 'initiated'
      OR (
        NEW.request_origin = 'user'
        AND upload_record.initiated_by_user_id IS DISTINCT FROM NEW.requested_by_user_id
      ) THEN
      RAISE EXCEPTION 'Successful multipart initiation must atomically transfer its exact actor-bound reservation to an initiated upload session.';
    END IF;
  END IF;
  IF NEW.status = 'canceled' AND NOT coalesce((
      (
        NEW.provider_started_at IS NULL
        AND NEW.provider_confirmed_at IS NULL
        AND NEW.result_payload->>'providerNotStarted' = 'true'
      )
      OR (
        NEW.provider_started_at IS NOT NULL
        AND NEW.provider_confirmed_at IS NOT NULL
        AND NEW.result_payload->>'cleanupConfirmed' = 'true'
        AND NEW.result_payload->>'reconciledAbsent' = 'true'
      )
    ), false) THEN
    RAISE EXCEPTION 'Canceled audio provider operations require exact proof that no provider state remains.';
  END IF;
  IF NEW.status = 'dead_letter'
    AND (
      NEW.last_error IS NULL
      OR length(btrim(NEW.last_error)) = 0
      OR NEW.last_error_code IS NULL
    ) THEN
    RAISE EXCEPTION 'Dead-letter audio provider operations require a durable failure reason and safe error code.';
  END IF;

  IF result_changed AND OLD.status = 'leased' AND NEW.result_fingerprint IS NOT NULL THEN
    UPDATE audio_provider_operation_attempts
    SET provider_result_fingerprint = NEW.result_fingerprint
    WHERE operation_id = OLD.id
      AND attempt_number = OLD.attempt_count
      AND fencing_token = OLD.lease_token;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Provider result evidence requires the matching durable attempt generation.';
    END IF;
  END IF;

  IF OLD.status = 'leased' AND NEW.status <> 'leased' THEN
    attempt_outcome := CASE NEW.status
      WHEN 'pending' THEN 'released'
      WHEN 'reconcile_required' THEN 'reconcile_required'
      WHEN 'awaiting_client_retry' THEN 'awaiting_client_retry'
      WHEN 'succeeded' THEN 'succeeded'
      WHEN 'canceled' THEN 'canceled'
      WHEN 'dead_letter' THEN 'dead_letter'
      ELSE NULL
    END;
    UPDATE audio_provider_operation_attempts
    SET outcome = attempt_outcome,
        error_code = NEW.last_error_code,
        completed_at = clock_timestamp()
    WHERE operation_id = OLD.id
      AND attempt_number = OLD.attempt_count
      AND fencing_token = OLD.lease_token;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Provider-operation finalization requires the matching active attempt generation.';
    END IF;
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_enforce_audio_provider_operation_resolution"() RETURNS trigger AS $$
DECLARE
  operation_record audio_provider_operations%ROWTYPE;
  upload_record audio_upload_sessions%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Audio provider operation resolutions are append-only evidence.';
  END IF;

  SELECT * INTO operation_record
  FROM audio_provider_operations
  WHERE id = NEW.operation_id;
  IF NOT FOUND OR operation_record.status <> 'dead_letter' THEN
    RAISE EXCEPTION 'Only an existing dead-letter provider operation may be resolved.';
  END IF;
  IF NEW.provider_observed_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Provider resolution observation time cannot be in the future.';
  END IF;
  IF NEW.resolved_by_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM audio_project_access_grants authority
    WHERE authority.project_id = operation_record.project_id
      AND authority.grantee_user_id = NEW.resolved_by_user_id
      AND authority.can_upload_versions = true
      AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'User-attributed provider resolution requires active project upload authority.';
  END IF;

  IF NEW.resolution_type = 'cleanup_confirmed' THEN
    IF NEW.upload_session_id IS NOT NULL
      OR NOT coalesce(NEW.evidence->>'multipartAbsent' = 'true', false)
      OR NOT coalesce(NEW.evidence->>'stagingAbsent' = 'true', false)
      OR NOT coalesce(NEW.evidence->>'sealedAbsent' = 'true', false) THEN
      RAISE EXCEPTION 'Cleanup resolution requires confirmed absence of multipart, staging, and sealed provider state.';
    END IF;
  ELSIF NEW.resolution_type = 'session_recovered' THEN
    SELECT * INTO upload_record
    FROM audio_upload_sessions
    WHERE id = NEW.upload_session_id;
    IF NOT FOUND
      OR upload_record.id IS DISTINCT FROM operation_record.planned_upload_session_id
      OR upload_record.project_id IS DISTINCT FROM operation_record.project_id
      OR upload_record.storage_provider IS DISTINCT FROM operation_record.storage_provider
      OR upload_record.storage_bucket IS DISTINCT FROM operation_record.storage_bucket
      OR upload_record.storage_key IS DISTINCT FROM operation_record.storage_key
      OR upload_record.provider_upload_id IS DISTINCT FROM operation_record.provider_upload_id
      OR upload_record.expected_byte_size IS DISTINCT FROM operation_record.reserved_byte_size
      OR (
        operation_record.request_origin = 'user'
        AND upload_record.initiated_by_user_id IS DISTINCT FROM operation_record.requested_by_user_id
      )
      OR NOT (
        upload_record.upload_status IN ('initiated', 'uploading', 'uploaded', 'verifying', 'quarantined')
        OR (
          upload_record.upload_status = 'completed'
          AND (
            EXISTS (
              SELECT 1
              FROM audio_project_asset_versions version
              WHERE version.upload_session_id = upload_record.id
                AND version.storage_provider = operation_record.storage_provider
                AND version.storage_bucket = operation_record.storage_bucket
                AND version.storage_key = operation_record.storage_key
                AND version.original_preserved = true
                AND version.sealed_at IS NOT NULL
            )
            OR EXISTS (
              SELECT 1
              FROM audio_candidate_revisions candidate
              WHERE candidate.upload_session_id = upload_record.id
                AND candidate.storage_provider = operation_record.storage_provider
                AND candidate.storage_bucket = operation_record.storage_bucket
                AND candidate.storage_key = operation_record.storage_key
                AND candidate.original_preserved = true
                AND candidate.sealed_at IS NOT NULL
            )
          )
        )
      ) THEN
      RAISE EXCEPTION 'Recovered session resolution must match the exact dead-letter provider intent.';
    END IF;
  END IF;

  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_record_audio_provider_operation_audit"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.attempt_count IS NOT DISTINCT FROM OLD.attempt_count
    AND NEW.provider_started_at IS NOT DISTINCT FROM OLD.provider_started_at
    AND NEW.provider_confirmed_at IS NOT DISTINCT FROM OLD.provider_confirmed_at
    AND NEW.upload_session_id IS NOT DISTINCT FROM OLD.upload_session_id
    AND NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code
    AND NEW.result_fingerprint IS NOT DISTINCT FROM OLD.result_fingerprint THEN
    RETURN NEW;
  END IF;

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
    CASE WHEN NEW.requested_by_user_id IS NULL THEN 'system' ELSE 'user' END,
    NEW.requested_by_user_id,
    'audio_provider_operation',
    NEW.id,
    CASE
      WHEN TG_OP = 'INSERT' THEN 'audio_provider_operation_reserved'
      ELSE 'audio_provider_operation_transition'
    END,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,
    jsonb_build_object(
      'operationType', NEW.operation_type,
      'attemptCount', NEW.attempt_count,
      'leaseMode', NEW.lease_mode,
      'providerCallStarted', NEW.provider_started_at IS NOT NULL,
      'providerConfirmed', NEW.provider_confirmed_at IS NOT NULL,
      'resultEvidenceRecorded', NEW.result_fingerprint IS NOT NULL,
      'sessionLinked', NEW.upload_session_id IS NOT NULL
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_record_audio_provider_resolution_audit"() RETURNS trigger AS $$
BEGIN
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
    CASE WHEN NEW.resolved_by_user_id IS NULL THEN 'system' ELSE 'user' END,
    NEW.resolved_by_user_id,
    'audio_provider_operation',
    NEW.operation_id,
    'audio_provider_operation_resolved',
    'dead_letter',
    'dead_letter',
    jsonb_build_object(
      'resolutionType', NEW.resolution_type,
      'sessionRecovered', NEW.upload_session_id IS NOT NULL,
      'providerAbsenceConfirmed', NEW.resolution_type = 'cleanup_confirmed'
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "audio_provider_operation_attempts_state" BEFORE INSERT OR UPDATE OR DELETE ON "audio_provider_operation_attempts" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_provider_attempt_state"();
--> statement-breakpoint
CREATE TRIGGER "audio_provider_operations_state" BEFORE INSERT OR UPDATE OR DELETE ON "audio_provider_operations" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_provider_operation_state"();
--> statement-breakpoint
CREATE TRIGGER "audio_provider_operation_resolutions_state" BEFORE INSERT OR UPDATE OR DELETE ON "audio_provider_operation_resolutions" FOR EACH ROW EXECUTE FUNCTION "sway_enforce_audio_provider_operation_resolution"();
--> statement-breakpoint
CREATE TRIGGER "audio_provider_operations_audit" AFTER INSERT OR UPDATE ON "audio_provider_operations" FOR EACH ROW EXECUTE FUNCTION "sway_record_audio_provider_operation_audit"();
--> statement-breakpoint
CREATE TRIGGER "audio_provider_operation_resolutions_audit" AFTER INSERT ON "audio_provider_operation_resolutions" FOR EACH ROW EXECUTE FUNCTION "sway_record_audio_provider_resolution_audit"();
