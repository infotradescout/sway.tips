SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
LOCK TABLE "performers" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE TABLE "performer_handle_claims" (
	"normalized_handle" text NOT NULL,
	"performer_id" uuid NOT NULL,
	"claim_kind" text NOT NULL,
	"legacy_exception" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_handle_claims_lowercase_handle" CHECK ("performer_handle_claims"."normalized_handle" = lower("performer_handle_claims"."normalized_handle")),
	CONSTRAINT "performer_handle_claims_valid_handle" CHECK (
		"performer_handle_claims"."normalized_handle" ~ '^[a-z0-9_-]{4,30}$'
		OR (
			"performer_handle_claims"."legacy_exception" = true
			AND "performer_handle_claims"."normalized_handle" ~ '^[a-z0-9_-]{1,64}$'
			AND "performer_handle_claims"."claim_kind" in ('canonical', 'redirect')
		)
	),
	CONSTRAINT "performer_handle_claims_kind_allowed" CHECK ("performer_handle_claims"."claim_kind" in ('canonical', 'redirect', 'reservation'))
);
--> statement-breakpoint
ALTER TABLE "performer_handle_claims" ADD CONSTRAINT "performer_handle_claims_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "performer_handle_claims_performer_idx" ON "performer_handle_claims" USING btree ("performer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "performer_handle_claims_canonical_performer_idx" ON "performer_handle_claims" USING btree ("performer_id") WHERE "performer_handle_claims"."claim_kind" = 'canonical';--> statement-breakpoint

-- Every claim mutation serializes on the same normalized-handle lock used by
-- performer inserts and renames. The primary key remains authoritative; the
-- lock only reduces contention. Claim ownership and identity never move.
CREATE FUNCTION "sway_guard_performer_handle_claim_identity"() RETURNS trigger AS $$
DECLARE
  performer_canonical_handle text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (
      SELECT 1 FROM "performers" p WHERE p."id" = OLD."performer_id"
    ) THEN
      RAISE EXCEPTION 'performer_handle_claim_cannot_be_deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW."normalized_handle" IS DISTINCT FROM OLD."normalized_handle"
    OR NEW."performer_id" IS DISTINCT FROM OLD."performer_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR NEW."legacy_exception" IS DISTINCT FROM OLD."legacy_exception"
  ) THEN
    RAISE EXCEPTION 'performer_handle_claim_identity_is_immutable';
  END IF;

  IF TG_OP = 'INSERT' AND NEW."legacy_exception" THEN
    RAISE EXCEPTION 'performer_handle_claim_legacy_exception_is_backfill_only';
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW."claim_kind" IS DISTINCT FROM OLD."claim_kind"
     AND NOT (
       (OLD."claim_kind" = 'canonical' AND NEW."claim_kind" = 'redirect')
       OR (OLD."claim_kind" = 'reservation' AND NEW."claim_kind" = 'canonical')
     ) THEN
    RAISE EXCEPTION 'performer_handle_claim_kind_transition_is_invalid';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."normalized_handle", 0));

  SELECT lower(p."handle")
    INTO performer_canonical_handle
    FROM "performers" p
   WHERE p."id" = NEW."performer_id";

  IF FOUND AND EXISTS (
    SELECT 1
      FROM "performers" p
     WHERE lower(p."handle") = NEW."normalized_handle"
       AND p."id" <> NEW."performer_id"
  ) THEN
    RAISE EXCEPTION 'performer_handle_claim_conflicts_with_canonical_handle'
      USING ERRCODE = 'unique_violation',
            CONSTRAINT = 'idx_performers_handle_lower';
  END IF;

  IF FOUND AND NEW."claim_kind" = 'canonical'
     AND performer_canonical_handle IS DISTINCT FROM NEW."normalized_handle" THEN
    RAISE EXCEPTION 'performer_handle_claim_canonical_mismatch'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'performer_handle_claims_canonical_matches_performer';
  END IF;

  IF FOUND AND NEW."claim_kind" IN ('redirect', 'reservation')
     AND performer_canonical_handle IS NOT DISTINCT FROM NEW."normalized_handle" THEN
    RAISE EXCEPTION 'performer_handle_claim_noncanonical_matches_performer'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'performer_handle_claims_noncanonical_differs_from_performer';
  END IF;

  NEW."updated_at" := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Establish canonical ownership for every existing performer. The table lock
-- closes the deployment gap: no performer write can commit between this
-- backfill and installation of the synchronization trigger.
INSERT INTO "performer_handle_claims" (
  "normalized_handle",
  "performer_id",
  "claim_kind",
  "legacy_exception"
)
SELECT
  lower(p."handle"),
  p."id",
  'canonical',
  lower(p."handle") !~ '^[a-z0-9_-]{4,30}$'
  FROM "performers" p
 WHERE p."handle" IS NOT NULL;
--> statement-breakpoint

-- Only the migration backfill may create a legacy exception. Once installed,
-- the guard makes 4-30 characters mandatory for every new claim while the two
-- currently deployed outliers remain reachable until their owners rename.
CREATE TRIGGER "performer_handle_claims_identity_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "performer_handle_claims"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_performer_handle_claim_identity"();
--> statement-breakpoint

-- Hand authoritative case-insensitive ownership from the legacy performer
-- index to the claim primary key while performer writes remain blocked.
DROP INDEX "idx_performers_handle_lower";
--> statement-breakpoint
ALTER TABLE "performer_handle_claims"
  ADD CONSTRAINT "idx_performers_handle_lower" PRIMARY KEY ("normalized_handle");
--> statement-breakpoint
CREATE INDEX "idx_performers_handle_lower_lookup"
  ON "performers" USING btree (lower("handle"))
  WHERE "performers"."handle" is not null;
--> statement-breakpoint

-- Reserve only the requested corrected spelling for the exact account. The
-- current edgewyze spelling is already represented by the canonical backfill.
DO $$
DECLARE
  target_performer_id constant uuid := 'b705a2fb-9491-4fa8-b9e9-b14b7e1c1289';
  target_handle text;
  target_owner_user_id uuid;
  claim_inserted integer;
BEGIN
  SELECT lower(p."handle"), p."owner_user_id"
    INTO target_handle, target_owner_user_id
    FROM "performers" p
   WHERE p."id" = target_performer_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF target_handle IS DISTINCT FROM 'edgewyze' THEN
    RAISE EXCEPTION 'EdgeWize reservation expected performer % to own edgewyze, found %.',
      target_performer_id, target_handle;
  END IF;

  INSERT INTO "performer_handle_claims" (
    "normalized_handle",
    "performer_id",
    "claim_kind"
  ) VALUES (
    'edgewize',
    target_performer_id,
    'reservation'
  )
  ON CONFLICT ("normalized_handle") DO NOTHING;
  GET DIAGNOSTICS claim_inserted = ROW_COUNT;

  IF NOT EXISTS (
    SELECT 1
      FROM "performer_handle_claims" c
     WHERE c."normalized_handle" = 'edgewize'
       AND c."performer_id" = target_performer_id
       AND c."claim_kind" = 'reservation'
  ) THEN
    RAISE EXCEPTION 'EdgeWize corrected handle has a conflicting claim.';
  END IF;

  IF claim_inserted = 1 THEN
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
      'performer_handle_claim.reserve',
      target_handle,
      'edgewize',
      jsonb_build_object(
        'operation', 'reserve_performer_handle_claim',
        'normalizedHandle', 'edgewize',
        'canonicalHandle', target_handle,
        'claimKind', 'reservation',
        'moneyFieldsChanged', false,
        'accessFieldsChanged', false
      )
    );
  END IF;
END;
$$;
--> statement-breakpoint

CREATE FUNCTION "sway_sync_performer_handle_claim"() RETURNS trigger AS $$
DECLARE
  old_normalized_handle text;
  new_normalized_handle text;
  existing_performer_id uuid;
  existing_claim_kind text;
  demoted_count integer;
BEGIN
  old_normalized_handle := CASE
    WHEN TG_OP = 'UPDATE' AND OLD."handle" IS NOT NULL THEN lower(OLD."handle")
    ELSE NULL
  END;
  new_normalized_handle := CASE
    WHEN NEW."handle" IS NOT NULL THEN lower(NEW."handle")
    ELSE NULL
  END;

  IF TG_OP = 'UPDATE'
     AND new_normalized_handle IS NOT DISTINCT FROM old_normalized_handle THEN
    RETURN NEW;
  END IF;

  -- Deterministic lock order avoids deadlocks when two renames touch the same
  -- pair of normalized handles in opposite directions.
  PERFORM pg_advisory_xact_lock(hashtextextended(handle_lock.normalized_handle, 0))
    FROM (
      SELECT DISTINCT candidate.normalized_handle
        FROM unnest(ARRAY[old_normalized_handle, new_normalized_handle])
          AS candidate(normalized_handle)
       WHERE candidate.normalized_handle IS NOT NULL
       ORDER BY candidate.normalized_handle
    ) AS handle_lock;

  IF old_normalized_handle IS NOT NULL THEN
    UPDATE "performer_handle_claims"
       SET "claim_kind" = 'redirect'
     WHERE "normalized_handle" = old_normalized_handle
       AND "performer_id" = NEW."id"
       AND "claim_kind" = 'canonical';
    GET DIAGNOSTICS demoted_count = ROW_COUNT;

    IF demoted_count <> 1 THEN
      RAISE EXCEPTION 'performer_handle_canonical_claim_missing';
    END IF;
  END IF;

  IF new_normalized_handle IS NOT NULL THEN
    SELECT c."performer_id", c."claim_kind"
      INTO existing_performer_id, existing_claim_kind
      FROM "performer_handle_claims" c
     WHERE c."normalized_handle" = new_normalized_handle
     FOR UPDATE;

    IF FOUND AND (
      existing_performer_id <> NEW."id"
      OR existing_claim_kind <> 'reservation'
    ) THEN
      RAISE EXCEPTION 'performer_handle_is_already_claimed'
        USING ERRCODE = 'unique_violation',
              CONSTRAINT = 'idx_performers_handle_lower';
    END IF;

    IF FOUND THEN
      UPDATE "performer_handle_claims"
         SET "claim_kind" = 'canonical'
       WHERE "normalized_handle" = new_normalized_handle
         AND "performer_id" = NEW."id"
         AND "claim_kind" = 'reservation';
    ELSE
      INSERT INTO "performer_handle_claims" (
        "normalized_handle",
        "performer_id",
        "claim_kind"
      ) VALUES (
        new_normalized_handle,
        NEW."id",
        'canonical'
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER "performers_handle_claim_sync"
  AFTER INSERT OR UPDATE OF "handle" ON "performers"
  FOR EACH ROW EXECUTE FUNCTION "sway_sync_performer_handle_claim"();
