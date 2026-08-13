CREATE TABLE "music_release_storage_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_event_id" uuid NOT NULL,
	"package_revision" integer NOT NULL,
	"package_fingerprint" text NOT NULL,
	"assets" jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "music_release_storage_manifests_source_type_allowed" CHECK ("music_release_storage_manifests"."source_type" in ('readiness_pass', 'delivery_submission')),
	CONSTRAINT "music_release_storage_manifests_revision_valid" CHECK ("music_release_storage_manifests"."package_revision" > 0),
	CONSTRAINT "music_release_storage_manifests_fingerprint_valid" CHECK ("music_release_storage_manifests"."package_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "music_release_storage_manifests_assets_required" CHECK (jsonb_typeof("music_release_storage_manifests"."assets") = 'array' and jsonb_array_length("music_release_storage_manifests"."assets") > 0)
);
--> statement-breakpoint
ALTER TABLE "music_release_storage_manifests" ADD CONSTRAINT "music_release_storage_manifests_release_id_music_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."music_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_release_storage_manifests" ADD CONSTRAINT "music_release_storage_manifests_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_release_storage_manifests" ADD CONSTRAINT "music_release_storage_manifests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "music_releases_id_performer_idx" ON "music_releases" USING btree ("id","performer_id");--> statement-breakpoint
ALTER TABLE "music_release_storage_manifests" ADD CONSTRAINT "music_release_storage_manifests_release_performer_fk" FOREIGN KEY ("release_id","performer_id") REFERENCES "public"."music_releases"("id","performer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "music_release_storage_manifests_release_revision_idx" ON "music_release_storage_manifests" USING btree ("release_id","package_revision");--> statement-breakpoint
CREATE UNIQUE INDEX "music_release_storage_manifests_release_fingerprint_idx" ON "music_release_storage_manifests" USING btree ("release_id","package_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "music_release_storage_manifests_source_event_idx" ON "music_release_storage_manifests" USING btree ("source_type","source_event_id");--> statement-breakpoint
CREATE INDEX "music_release_storage_manifests_performer_created_idx" ON "music_release_storage_manifests" USING btree ("performer_id","created_at");
--> statement-breakpoint
CREATE FUNCTION "sway_validate_music_release_storage_manifest"() RETURNS trigger AS $$
DECLARE
  release_record music_releases%ROWTYPE;
  expected_revision integer;
BEGIN
  SELECT * INTO release_record
  FROM music_releases
  WHERE id = NEW.release_id
    AND performer_id = NEW.performer_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Release storage manifests must match the release performer.';
  END IF;
  IF release_record.status NOT IN ('ready', 'scheduled', 'published', 'takedown_requested', 'taken_down') THEN
    RAISE EXCEPTION 'Release storage manifests require a rights-ready release state.';
  END IF;

  SELECT coalesce(max(package_revision), 0) + 1 INTO expected_revision
  FROM music_release_storage_manifests
  WHERE release_id = NEW.release_id;
  IF NEW.package_revision <> expected_revision THEN
    RAISE EXCEPTION 'Release storage manifest revision must be the next immutable package revision.';
  END IF;

  IF NEW.source_type = 'readiness_pass' AND NOT EXISTS (
    SELECT 1
    FROM music_rights_declaration_events review_event
    INNER JOIN music_rights_declarations declaration
      ON declaration.id = review_event.declaration_id
    WHERE review_event.id = NEW.source_event_id
      AND review_event.actor_user_id = NEW.created_by_user_id
      AND review_event.event_type = 'verified'
      AND declaration.release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION 'Readiness storage manifests require the exact immutable verification event.';
  END IF;

  IF NEW.source_type = 'delivery_submission' AND NOT EXISTS (
    SELECT 1
    FROM music_distribution_delivery_events delivery_event
    INNER JOIN music_distribution_deliveries delivery
      ON delivery.id = delivery_event.delivery_id
    WHERE delivery_event.id = NEW.source_event_id
      AND delivery_event.actor_user_id = NEW.created_by_user_id
      AND delivery_event.event_type = 'status_changed'
      AND delivery_event.next_status IN ('submitted', 'accepted', 'live')
      AND delivery.release_id = NEW.release_id
  ) THEN
    RAISE EXCEPTION 'Delivery storage manifests require the exact immutable provider-submission transition.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.assets) asset
    WHERE jsonb_typeof(asset) <> 'object'
      OR NOT (asset ? 'assetVersionId' AND asset ? 'sha256' AND asset ? 'byteSize' AND asset ? 'roles')
      OR coalesce(asset->>'assetVersionId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR coalesce(asset->>'sha256', '') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(asset->'byteSize') <> 'number'
      OR coalesce(asset->>'byteSize', '') !~ '^[1-9][0-9]*$'
      OR jsonb_typeof(asset->'roles') <> 'array'
      OR jsonb_array_length(asset->'roles') = 0
  ) THEN
    RAISE EXCEPTION 'Release storage manifest assets require exact version, hash, byte-size, and role fields.';
  END IF;

  IF (
    SELECT count(*) <> count(DISTINCT asset->>'assetVersionId')
    FROM jsonb_array_elements(NEW.assets) asset
  ) THEN
    RAISE EXCEPTION 'Release storage manifests may list each asset version only once.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.assets) asset
    LEFT JOIN audio_project_asset_versions version
      ON version.id = (asset->>'assetVersionId')::uuid
    WHERE version.id IS NULL
      OR version.performer_id <> NEW.performer_id
      OR version.sha256 <> asset->>'sha256'
      OR version.byte_size <> (asset->>'byteSize')::bigint
      OR version.sealed_at IS NULL
      OR version.original_preserved <> true
      OR version.integrity_status <> 'verified'
  ) THEN
    RAISE EXCEPTION 'Release storage manifest assets must match exact sealed performer-owned versions.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.assets) asset
    CROSS JOIN LATERAL jsonb_array_elements(asset->'roles') role_value
    WHERE jsonb_typeof(role_value) <> 'string'
  ) THEN
    RAISE EXCEPTION 'Release storage manifest roles must be strings.';
  END IF;

  IF (
    WITH manifest_roles AS (
      SELECT jsonb_array_elements_text(asset->'roles') AS role
      FROM jsonb_array_elements(NEW.assets) asset
    )
    SELECT count(*) <> count(DISTINCT role) FROM manifest_roles
  ) THEN
    RAISE EXCEPTION 'Release storage manifest roles must be unique within a package.';
  END IF;

  IF EXISTS (
    WITH manifest_roles AS (
      SELECT jsonb_array_elements_text(asset->'roles') AS role
      FROM jsonb_array_elements(NEW.assets) asset
    )
    SELECT 1 FROM manifest_roles
    WHERE role <> 'release_artwork'
      AND role !~* '^recording_master:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND role !~* '^rights_document:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) THEN
    RAISE EXCEPTION 'Release storage manifest contains an unsupported asset role.';
  END IF;

  IF release_record.artwork_asset_version_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.assets) asset
    CROSS JOIN LATERAL jsonb_array_elements_text(asset->'roles') role(role_name)
    WHERE role_name = 'release_artwork'
      AND (asset->>'assetVersionId')::uuid = release_record.artwork_asset_version_id
  ) THEN
    RAISE EXCEPTION 'Release storage manifests require the exact current release artwork.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM music_release_recordings
    WHERE release_id = NEW.release_id
  ) OR EXISTS (
    SELECT 1
    FROM music_release_recordings release_recording
    INNER JOIN music_recordings recording
      ON recording.id = release_recording.recording_id
    WHERE release_recording.release_id = NEW.release_id
      AND (
        recording.master_asset_version_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(NEW.assets) asset
          CROSS JOIN LATERAL jsonb_array_elements_text(asset->'roles') role(role_name)
          WHERE role_name = 'recording_master:' || recording.id::text
            AND (asset->>'assetVersionId')::uuid = recording.master_asset_version_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'Release storage manifests require one exact master role for every release recording.';
  END IF;

  IF EXISTS (
    WITH manifest_roles AS (
      SELECT
        (asset->>'assetVersionId')::uuid AS asset_version_id,
        jsonb_array_elements_text(asset->'roles') AS role
      FROM jsonb_array_elements(NEW.assets) asset
    )
    SELECT 1
    FROM manifest_roles
    WHERE role LIKE 'recording_master:%'
      AND NOT EXISTS (
        SELECT 1
        FROM music_release_recordings release_recording
        INNER JOIN music_recordings recording
          ON recording.id = release_recording.recording_id
        WHERE release_recording.release_id = NEW.release_id
          AND recording.id = split_part(role, ':', 2)::uuid
          AND recording.master_asset_version_id = manifest_roles.asset_version_id
      )
  ) THEN
    RAISE EXCEPTION 'Release storage manifest master roles must match current release recordings.';
  END IF;

  IF EXISTS (
    WITH manifest_roles AS (
      SELECT
        (asset->>'assetVersionId')::uuid AS asset_version_id,
        jsonb_array_elements_text(asset->'roles') AS role
      FROM jsonb_array_elements(NEW.assets) asset
    )
    SELECT 1
    FROM manifest_roles
    WHERE role LIKE 'rights_document:%'
      AND NOT EXISTS (
        SELECT 1
        FROM music_rights_declarations declaration
        WHERE declaration.id = split_part(role, ':', 2)::uuid
          AND declaration.release_id = NEW.release_id
          AND declaration.terms_document_asset_version_id = manifest_roles.asset_version_id
          AND EXISTS (
            SELECT 1 FROM music_rights_declaration_events review_event
            WHERE review_event.declaration_id = declaration.id
              AND review_event.event_type = 'verified'
          )
          AND NOT EXISTS (
            SELECT 1 FROM music_rights_declaration_events later_event
            WHERE later_event.declaration_id = declaration.id
              AND later_event.event_type IN ('rejected', 'revoked')
          )
          AND NOT EXISTS (
            SELECT 1 FROM music_rights_declarations later_declaration
            WHERE later_declaration.release_id = declaration.release_id
              AND later_declaration.recording_id IS NOT DISTINCT FROM declaration.recording_id
              AND later_declaration.declaration_type = declaration.declaration_type
              AND (later_declaration.declared_at, later_declaration.id)
                > (declaration.declared_at, declaration.id)
          )
      )
  ) THEN
    RAISE EXCEPTION 'Release storage manifest rights roles require exact latest verified declarations.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM music_release_recordings release_recording
    CROSS JOIN (VALUES ('master_control'), ('composition_control')) required(declaration_type)
    LEFT JOIN LATERAL (
      SELECT declaration.*
      FROM music_rights_declarations declaration
      WHERE declaration.release_id = NEW.release_id
        AND declaration.recording_id = release_recording.recording_id
        AND declaration.declaration_type = required.declaration_type
      ORDER BY declaration.declared_at DESC, declaration.id DESC
      LIMIT 1
    ) declaration ON true
    WHERE release_recording.release_id = NEW.release_id
      AND (
        declaration.id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM music_rights_declaration_events review_event
          WHERE review_event.declaration_id = declaration.id
            AND review_event.event_type = 'verified'
        )
        OR EXISTS (
          SELECT 1 FROM music_rights_declaration_events later_event
          WHERE later_event.declaration_id = declaration.id
            AND later_event.event_type IN ('rejected', 'revoked')
        )
        OR NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(NEW.assets) asset
          CROSS JOIN LATERAL jsonb_array_elements_text(asset->'roles') role(role_name)
          WHERE role_name = 'rights_document:' || declaration.id::text
            AND (asset->>'assetVersionId')::uuid = declaration.terms_document_asset_version_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'Release storage manifests require verified master and composition rights for every recording.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES ('artwork_control'), ('distribution_authorization')) required(declaration_type)
    LEFT JOIN LATERAL (
      SELECT declaration.*
      FROM music_rights_declarations declaration
      WHERE declaration.release_id = NEW.release_id
        AND declaration.recording_id IS NULL
        AND declaration.declaration_type = required.declaration_type
      ORDER BY declaration.declared_at DESC, declaration.id DESC
      LIMIT 1
    ) declaration ON true
    WHERE declaration.id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM music_rights_declaration_events review_event
        WHERE review_event.declaration_id = declaration.id
          AND review_event.event_type = 'verified'
      )
      OR EXISTS (
        SELECT 1 FROM music_rights_declaration_events later_event
        WHERE later_event.declaration_id = declaration.id
          AND later_event.event_type IN ('rejected', 'revoked')
      )
      OR NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.assets) asset
        CROSS JOIN LATERAL jsonb_array_elements_text(asset->'roles') role(role_name)
        WHERE role_name = 'rights_document:' || declaration.id::text
          AND (asset->>'assetVersionId')::uuid = declaration.terms_document_asset_version_id
      )
  ) THEN
    RAISE EXCEPTION 'Release storage manifests require verified artwork and distribution authorization.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "music_release_storage_manifests_validate"
BEFORE INSERT ON "music_release_storage_manifests"
FOR EACH ROW EXECUTE FUNCTION "sway_validate_music_release_storage_manifest"();
--> statement-breakpoint
CREATE TRIGGER "music_release_storage_manifests_append_only"
BEFORE UPDATE OR DELETE ON "music_release_storage_manifests"
FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
