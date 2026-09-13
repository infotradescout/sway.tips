-- Owner disposition preserves the private intake record and the source version.
-- Acceptance adds one ordinary private working version; it grants no release rights.
CREATE TABLE "audio_candidate_owner_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "candidate_id" uuid NOT NULL REFERENCES "audio_candidate_revisions"("id"),
  "project_id" uuid NOT NULL REFERENCES "audio_projects"("id"),
  "performer_id" uuid NOT NULL REFERENCES "performers"("id"),
  "actor_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "decision" text NOT NULL,
  "promoted_version_id" uuid REFERENCES "audio_project_asset_versions"("id") DEFERRABLE INITIALLY DEFERRED,
  "idempotency_key_hash" text NOT NULL,
  "intent_fingerprint" text NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "audio_candidate_owner_decisions_allowed" CHECK ("decision" IN ('accepted', 'rejected', 'blocked')),
  CONSTRAINT "audio_candidate_owner_decisions_version_coherent" CHECK (("decision" = 'accepted') = ("promoted_version_id" IS NOT NULL)),
  CONSTRAINT "audio_candidate_owner_decisions_key_valid" CHECK ("idempotency_key_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audio_candidate_owner_decisions_intent_valid" CHECK ("intent_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "audio_candidate_owner_decisions_reason_valid" CHECK (("reason" IS NULL OR length("reason") BETWEEN 1 AND 2000) AND ("decision" <> 'blocked' OR length(btrim("reason")) > 0 AND "reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_candidate_owner_decisions_candidate_idx" ON "audio_candidate_owner_decisions" ("candidate_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_candidate_owner_decisions_version_idx" ON "audio_candidate_owner_decisions" ("promoted_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "audio_candidate_owner_decisions_actor_key_idx" ON "audio_candidate_owner_decisions" ("actor_user_id", "idempotency_key_hash");
--> statement-breakpoint
CREATE INDEX "audio_candidate_owner_decisions_project_created_idx" ON "audio_candidate_owner_decisions" ("project_id", "created_at");
--> statement-breakpoint
CREATE FUNCTION "sway_require_audio_candidate_decision_authority"(
  p_candidate_id uuid, p_actor_user_id uuid, p_accepting boolean
) RETURNS void AS $$
DECLARE
  scope_record record;
  latest_moderation moderation_status;
BEGIN
  -- Lock the owner before project authority, matching capability decision ordering.
  SELECT candidate.project_id, candidate.performer_id INTO scope_record
  FROM audio_candidate_revisions candidate JOIN performers performer ON performer.id = candidate.performer_id
  WHERE candidate.id = p_candidate_id AND performer.owner_user_id = p_actor_user_id
  FOR UPDATE OF performer;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Only the current performer owner may decide this candidate.' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM audio_project_access_grants authority
  WHERE authority.project_id = scope_record.project_id
    AND authority.grantee_user_id = p_actor_user_id
    AND authority.can_manage_access AND authority.can_upload_versions
    AND authority.revoked_at IS NULL
    AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  ORDER BY authority.id LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Candidate decisions require current project manage and upload authority.' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM audio_candidate_revisions WHERE id = p_candidate_id FOR UPDATE;
  IF p_accepting THEN
    PERFORM sway_require_current_performer_capability(scope_record.performer_id, 'private_collaboration'::performer_capability);
    SELECT status INTO latest_moderation FROM moderation_events
    WHERE entity_type = 'audio_candidate_revision' AND entity_id = p_candidate_id
    ORDER BY created_at DESC, id DESC LIMIT 1;
    IF latest_moderation IN ('held_for_review', 'blocked') THEN
      RAISE EXCEPTION 'A held or blocked candidate cannot be accepted.' USING ERRCODE = '42501';
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_validate_audio_candidate_owner_decision"() RETURNS trigger AS $$
DECLARE
  candidate_record audio_candidate_revisions%ROWTYPE;
BEGIN
  PERFORM sway_require_audio_candidate_decision_authority(NEW.candidate_id, NEW.actor_user_id, NEW.decision = 'accepted');
  SELECT * INTO STRICT candidate_record FROM audio_candidate_revisions WHERE id = NEW.candidate_id;
  IF NEW.project_id <> candidate_record.project_id OR NEW.performer_id <> candidate_record.performer_id THEN
    RAISE EXCEPTION 'Candidate owner decision scope must match its immutable candidate.';
  END IF;
  IF NEW.decision = 'accepted' AND EXISTS (SELECT 1 FROM audio_project_asset_versions WHERE id = NEW.promoted_version_id) THEN
    RAISE EXCEPTION 'Candidate acceptance must create a new private working version.';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_audio_candidate_version_binding_valid"(proposed audio_project_asset_versions) RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM audio_candidate_owner_decisions decision
    JOIN audio_candidate_revisions candidate ON candidate.id = decision.candidate_id
    JOIN audio_project_asset_versions source ON source.id = candidate.source_asset_version_id
    WHERE decision.decision = 'accepted' AND decision.promoted_version_id = proposed.id
      AND decision.project_id = proposed.project_id AND decision.performer_id = proposed.performer_id
      AND candidate.project_id = proposed.project_id AND candidate.performer_id = proposed.performer_id
      AND source.id <> proposed.id AND source.asset_id = candidate.asset_id
      AND source.project_id = candidate.project_id AND source.performer_id = candidate.performer_id
      AND candidate.asset_id = proposed.asset_id AND candidate.upload_session_id = proposed.upload_session_id
      AND candidate.uploaded_by_user_id = proposed.uploaded_by_user_id
      AND candidate.original_filename = proposed.original_filename
      AND candidate.storage_provider = proposed.storage_provider AND candidate.storage_bucket = proposed.storage_bucket
      AND candidate.storage_key = proposed.storage_key
      AND candidate.provider_version_id IS NOT DISTINCT FROM proposed.provider_version_id
      AND candidate.mime_type = proposed.mime_type AND candidate.byte_size = proposed.byte_size AND candidate.sha256 = proposed.sha256
      AND candidate.duration_ms = proposed.duration_ms AND candidate.codec IS NOT DISTINCT FROM proposed.codec
      AND candidate.sample_rate_hz IS NOT DISTINCT FROM proposed.sample_rate_hz
      AND candidate.bit_depth IS NOT DISTINCT FROM proposed.bit_depth AND candidate.channel_count IS NOT DISTINCT FROM proposed.channel_count
      AND candidate.integrity_status = proposed.integrity_status AND candidate.integrity_verifier_key = proposed.integrity_verifier_key
      AND candidate.integrity_verified_at = proposed.integrity_verified_at AND candidate.integrity_evidence = proposed.integrity_evidence
      AND candidate.original_preserved AND proposed.original_preserved
      AND proposed.metadata->>'candidateRevisionId' = candidate.id::text
      AND proposed.metadata->>'sourceAssetVersionId' = candidate.source_asset_version_id::text
      AND proposed.metadata->>'ownerDecisionId' = decision.id::text
  );
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_require_audio_candidate_promoted_version"() RETURNS trigger AS $$
DECLARE
  promoted audio_project_asset_versions%ROWTYPE;
BEGIN
  IF NEW.decision = 'accepted' THEN
    SELECT * INTO promoted FROM audio_project_asset_versions WHERE id = NEW.promoted_version_id;
    IF NOT FOUND OR NOT sway_audio_candidate_version_binding_valid(promoted) THEN
      RAISE EXCEPTION 'Accepted candidate requires its exact newly sealed private working version.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sway_reject_candidate_session_asset_version"() RETURNS trigger AS $$
DECLARE
  owner_decision audio_candidate_owner_decisions%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM audio_upload_sessions WHERE id = NEW.upload_session_id AND upload_purpose = 'collaborator_revision') THEN
    SELECT * INTO owner_decision FROM audio_candidate_owner_decisions WHERE promoted_version_id = NEW.id AND decision = 'accepted';
    IF NOT FOUND OR NOT sway_audio_candidate_version_binding_valid(NEW) THEN
      RAISE EXCEPTION 'Collaborator revision sessions require an exact immutable owner acceptance before project-version sealing.';
    END IF;
    PERFORM sway_require_audio_candidate_decision_authority(owner_decision.candidate_id, owner_decision.actor_user_id, true);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "sway_validate_audio_asset_version_seal"() RETURNS trigger AS $$
DECLARE
  upload_record audio_upload_sessions%ROWTYPE;
BEGIN
  SELECT * INTO upload_record FROM audio_upload_sessions WHERE id = NEW.upload_session_id FOR UPDATE;
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
  IF upload_record.upload_purpose = 'collaborator_revision' THEN
    IF NOT sway_audio_candidate_version_binding_valid(NEW) THEN
      RAISE EXCEPTION 'Candidate upload authority cannot replace current explicit owner acceptance.';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM audio_project_access_grants authority
    WHERE authority.project_id = NEW.project_id AND authority.grantee_user_id = NEW.uploaded_by_user_id
      AND authority.can_upload_versions = true AND authority.revoked_at IS NULL
      AND (authority.expires_at IS NULL OR authority.expires_at > clock_timestamp())
  ) THEN
    RAISE EXCEPTION 'Sealing an audio version requires active upload authority for the project.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_record_audio_candidate_owner_decision"() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_events (actor_type, actor_id, entity_type, entity_id, event_type, previous_status, next_status, metadata)
  VALUES ('account', NEW.actor_user_id, 'audio_candidate_revision', NEW.candidate_id,
    'audio_candidate.' || NEW.decision, 'private_review', NEW.decision,
    jsonb_build_object('decisionId', NEW.id, 'projectId', NEW.project_id, 'performerId', NEW.performer_id,
      'promotedVersionId', NEW.promoted_version_id, 'reason', NEW.reason));
  IF NEW.decision = 'blocked' THEN
    INSERT INTO moderation_events (actor_user_id, entity_type, entity_id, status, reason, metadata)
    VALUES (NEW.actor_user_id, 'audio_candidate_revision', NEW.candidate_id, 'blocked', NEW.reason,
      jsonb_build_object('ownerDecisionId', NEW.id));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE FUNCTION "sway_lock_audio_candidate_moderation"() RETURNS trigger AS $$
DECLARE
  current_owner_user_id uuid;
  actor_role user_role;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.entity_type = 'audio_candidate_revision' OR (TG_OP = 'UPDATE' AND NEW.entity_type = 'audio_candidate_revision') THEN
      RAISE EXCEPTION 'Candidate moderation events are immutable; record a new authorized review outcome.';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NEW.entity_type = 'audio_candidate_revision' THEN
    SELECT performer.owner_user_id INTO current_owner_user_id
    FROM audio_candidate_revisions candidate JOIN performers performer ON performer.id = candidate.performer_id
    WHERE candidate.id = NEW.entity_id FOR UPDATE OF performer;
    IF NOT FOUND THEN RAISE EXCEPTION 'Candidate moderation requires an existing private candidate.'; END IF;
    SELECT role INTO actor_role FROM users WHERE id = NEW.actor_user_id FOR SHARE;
    IF NOT FOUND OR (actor_role <> 'admin' AND NEW.actor_user_id IS DISTINCT FROM current_owner_user_id)
      OR (NEW.status = 'allowed' AND actor_role <> 'admin') THEN
      RAISE EXCEPTION 'Candidate moderation requires its current owner or an administrator; only an administrator may clear a hold.' USING ERRCODE = '42501';
    END IF;
    PERFORM 1 FROM audio_candidate_revisions WHERE id = NEW.entity_id FOR UPDATE;
    -- Strict event order under the candidate lock avoids timestamp ties or caller
    -- backdating changing which moderation decision controls acceptance.
    SELECT greatest(clock_timestamp(), coalesce(max(created_at) + interval '1 microsecond', '-infinity'::timestamptz))
      INTO NEW.created_at FROM moderation_events
    WHERE entity_type = 'audio_candidate_revision' AND entity_id = NEW.entity_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "audio_candidate_owner_decisions_validate" BEFORE INSERT ON "audio_candidate_owner_decisions" FOR EACH ROW EXECUTE FUNCTION "sway_validate_audio_candidate_owner_decision"();
--> statement-breakpoint
CREATE TRIGGER "audio_candidate_owner_decisions_immutable" BEFORE UPDATE OR DELETE ON "audio_candidate_owner_decisions" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "audio_candidate_owner_decisions_promoted_binding" AFTER INSERT ON "audio_candidate_owner_decisions" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "sway_require_audio_candidate_promoted_version"();
--> statement-breakpoint
CREATE TRIGGER "audio_candidate_owner_decisions_audit" AFTER INSERT ON "audio_candidate_owner_decisions" FOR EACH ROW EXECUTE FUNCTION "sway_record_audio_candidate_owner_decision"();
--> statement-breakpoint
CREATE TRIGGER "audio_candidate_moderation_lock" BEFORE INSERT OR UPDATE OR DELETE ON "moderation_events" FOR EACH ROW EXECUTE FUNCTION "sway_lock_audio_candidate_moderation"();
