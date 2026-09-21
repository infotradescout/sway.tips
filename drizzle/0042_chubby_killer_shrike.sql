-- Drizzle applies each migration in a transaction. Hold these legacy writer
-- tables from preflight through trigger installation and backfill so a rolling
-- old instance cannot write into the snapshot gap.
LOCK TABLE "performers", "stripe_connect_onboarding_operations"
  IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint

-- Refuse to reinterpret a corrupted historical provider idempotency identity.
-- This preflight intentionally runs before any 0042 object is created.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "stripe_connect_onboarding_operations" o
    WHERE o."operation_key" <> (
      'sway-connect-recipient:' || o."performer_id"::text
      || ':owner:' || o."owner_user_id"::text || ':v1'
    )
  ) THEN
    RAISE EXCEPTION 'legacy Stripe Connect operation key is noncanonical';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "stripe_connect_onboarding_operations" o
    JOIN "performers" p ON p."id" = o."performer_id"
    WHERE o."owner_user_id" <> p."owner_user_id"
  ) THEN
    RAISE EXCEPTION 'legacy Stripe Connect operation owner mismatch';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "performers" p
    JOIN "stripe_connect_onboarding_operations" o
      ON o."performer_id" = p."id"
    WHERE p."stripe_connected_account_id" IS NOT NULL
      AND o."stripe_account_id" IS NOT NULL
      AND p."stripe_connected_account_id" <> o."stripe_account_id"
  ) THEN
    RAISE EXCEPTION 'legacy Stripe Connect account identity mismatch';
  END IF;
END;
$$;--> statement-breakpoint

CREATE TABLE "performer_stripe_connect_bindings" (
	"performer_id" uuid NOT NULL,
	"payment_mode" text NOT NULL,
	"stripe_account_id" text NOT NULL,
	"payment_account_status" "payment_account_status" DEFAULT 'not_started' NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"payouts_enabled" boolean DEFAULT false NOT NULL,
	"status_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_stripe_connect_bindings_performer_id_payment_mode_pk" PRIMARY KEY("performer_id","payment_mode"),
	CONSTRAINT "performer_stripe_connect_bindings_payment_mode_allowed" CHECK ("performer_stripe_connect_bindings"."payment_mode" in ('test', 'live'))
);
--> statement-breakpoint
CREATE TABLE "stripe_connect_mode_onboarding_operations" (
	"performer_id" uuid NOT NULL,
	"payment_mode" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_account_id" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_connect_mode_onboarding_operations_performer_id_payment_mode_pk" PRIMARY KEY("performer_id","payment_mode"),
	CONSTRAINT "stripe_connect_mode_onboarding_operations_payment_mode_allowed" CHECK ("stripe_connect_mode_onboarding_operations"."payment_mode" in ('test', 'live')),
	CONSTRAINT "stripe_connect_mode_onboarding_operations_status_allowed" CHECK ("stripe_connect_mode_onboarding_operations"."status" in ('pending', 'provisioning', 'bound')),
	CONSTRAINT "stripe_connect_mode_onboarding_operations_attempt_count_valid" CHECK ("stripe_connect_mode_onboarding_operations"."attempt_count" >= 0),
	CONSTRAINT "stripe_connect_mode_onboarding_operations_lease_consistent" CHECK ((
      ("stripe_connect_mode_onboarding_operations"."status" = 'provisioning' and "stripe_connect_mode_onboarding_operations"."lease_token" is not null and "stripe_connect_mode_onboarding_operations"."lease_expires_at" is not null)
      or
      ("stripe_connect_mode_onboarding_operations"."status" <> 'provisioning' and "stripe_connect_mode_onboarding_operations"."lease_token" is null and "stripe_connect_mode_onboarding_operations"."lease_expires_at" is null)
    )),
	CONSTRAINT "stripe_connect_mode_onboarding_operations_bound_account_required" CHECK ("stripe_connect_mode_onboarding_operations"."status" <> 'bound' or "stripe_connect_mode_onboarding_operations"."stripe_account_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD COLUMN "payment_mode" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_mode" text DEFAULT 'test' NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_stripe_connect_bindings" ADD CONSTRAINT "performer_stripe_connect_bindings_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_connect_mode_onboarding_operations" ADD CONSTRAINT "stripe_connect_mode_onboarding_operations_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_connect_mode_onboarding_operations" ADD CONSTRAINT "stripe_connect_mode_onboarding_operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "performer_stripe_connect_bindings_account_mode_idx" ON "performer_stripe_connect_bindings" USING btree ("payment_mode","stripe_account_id");--> statement-breakpoint
CREATE INDEX "performer_stripe_connect_bindings_performer_idx" ON "performer_stripe_connect_bindings" USING btree ("performer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_connect_mode_onboarding_operations_key_idx" ON "stripe_connect_mode_onboarding_operations" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_connect_mode_onboarding_operations_account_mode_idx" ON "stripe_connect_mode_onboarding_operations" USING btree ("payment_mode","stripe_account_id") WHERE "stripe_connect_mode_onboarding_operations"."stripe_account_id" is not null;--> statement-breakpoint
ALTER TABLE "live_room_payment_operations" ADD CONSTRAINT "live_room_payment_operations_payment_mode_allowed" CHECK ("live_room_payment_operations"."payment_mode" in ('test', 'live'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_mode_allowed" CHECK ("payments"."payment_mode" in ('test', 'live'));--> statement-breakpoint

CREATE FUNCTION "sway_guard_stripe_connect_binding_identity"() RETURNS trigger AS $$
BEGIN
  IF NEW."performer_id" IS DISTINCT FROM OLD."performer_id"
    OR NEW."payment_mode" IS DISTINCT FROM OLD."payment_mode"
    OR NEW."stripe_account_id" IS DISTINCT FROM OLD."stripe_account_id" THEN
    RAISE EXCEPTION 'stripe_connect_binding_identity_is_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "performer_stripe_connect_bindings_identity_guard"
  BEFORE UPDATE ON "performer_stripe_connect_bindings"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_stripe_connect_binding_identity"();--> statement-breakpoint

CREATE FUNCTION "sway_guard_stripe_connect_mode_operation_identity"() RETURNS trigger AS $$
BEGIN
  IF NEW."performer_id" IS DISTINCT FROM OLD."performer_id"
    OR NEW."payment_mode" IS DISTINCT FROM OLD."payment_mode"
    OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
    OR NEW."operation_key" IS DISTINCT FROM OLD."operation_key" THEN
    RAISE EXCEPTION 'stripe_connect_mode_operation_identity_is_immutable';
  END IF;
  IF OLD."stripe_account_id" IS NOT NULL
    AND NEW."stripe_account_id" IS DISTINCT FROM OLD."stripe_account_id" THEN
    RAISE EXCEPTION 'stripe_connect_mode_operation_account_is_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "stripe_connect_mode_onboarding_operations_identity_guard"
  BEFORE UPDATE ON "stripe_connect_mode_onboarding_operations"
  FOR EACH ROW EXECUTE FUNCTION "sway_guard_stripe_connect_mode_operation_identity"();--> statement-breakpoint

-- Expand/contract bridge for a rolling deploy. Old application instances
-- continue to write only the legacy test-mode operation and performer
-- columns; mirror those writes one-way into the explicit test lane. No live
-- row is ever projected back into legacy state.
CREATE FUNCTION "sway_mirror_legacy_stripe_connect_operation_to_test_mode"() RETURNS trigger AS $$
DECLARE
  current_mode "stripe_connect_mode_onboarding_operations"%ROWTYPE;
  current_lease_active boolean;
  next_lease_active boolean;
BEGIN
  IF NEW."operation_key" <> (
    'sway-connect-recipient:' || NEW."performer_id"::text
    || ':owner:' || NEW."owner_user_id"::text || ':v1'
  ) OR NOT EXISTS (
    SELECT 1 FROM "performers" p
    WHERE p."id" = NEW."performer_id"
      AND p."owner_user_id" = NEW."owner_user_id"
  ) THEN
    RAISE EXCEPTION 'stripe_connect_test_operation_identity_conflict';
  END IF;

  SELECT * INTO current_mode
  FROM "stripe_connect_mode_onboarding_operations"
  WHERE "performer_id" = NEW."performer_id" AND "payment_mode" = 'test'
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO "stripe_connect_mode_onboarding_operations" (
      "performer_id",
      "payment_mode",
      "owner_user_id",
      "operation_key",
      "status",
      "stripe_account_id",
      "lease_token",
      "lease_expires_at",
      "attempt_count",
      "last_error",
      "created_at",
      "updated_at"
    ) VALUES (
      NEW."performer_id",
      'test',
      NEW."owner_user_id",
      NEW."operation_key",
      NEW."status",
      NEW."stripe_account_id",
      NEW."lease_token",
      NEW."lease_expires_at",
      NEW."attempt_count",
      NEW."last_error",
      NEW."created_at",
      NEW."updated_at"
    );
    RETURN NEW;
  END IF;

  IF current_mode."owner_user_id" <> NEW."owner_user_id"
    OR current_mode."operation_key" <> NEW."operation_key" THEN
    RAISE EXCEPTION 'stripe_connect_test_operation_identity_conflict';
  END IF;
  IF current_mode."stripe_account_id" IS NOT NULL
    AND current_mode."stripe_account_id" IS DISTINCT FROM NEW."stripe_account_id" THEN
    RAISE EXCEPTION 'stripe_connect_test_operation_account_conflict';
  END IF;
  IF current_mode."status" = 'bound' AND NEW."status" <> 'bound' THEN
    RAISE EXCEPTION 'stripe_connect_test_operation_bound_state_conflict';
  END IF;
  IF NEW."attempt_count" < current_mode."attempt_count" THEN
    RAISE EXCEPTION 'stripe_connect_test_operation_attempt_conflict';
  END IF;

  current_lease_active := current_mode."status" = 'provisioning'
    AND current_mode."lease_token" IS NOT NULL
    AND current_mode."lease_expires_at" IS NOT NULL;
  next_lease_active := NEW."status" = 'provisioning'
    AND NEW."lease_token" IS NOT NULL
    AND NEW."lease_expires_at" IS NOT NULL;

  IF current_lease_active AND next_lease_active
    AND current_mode."lease_token" IS DISTINCT FROM NEW."lease_token"
    AND NOT (
      TG_OP = 'UPDATE'
      AND OLD."lease_token" = current_mode."lease_token"
      AND current_mode."lease_expires_at" <= CURRENT_TIMESTAMP
    ) THEN
    RAISE EXCEPTION 'stripe_connect_test_operation_lease_conflict';
  END IF;
  IF current_lease_active AND NOT next_lease_active
    AND NOT (
      TG_OP = 'UPDATE'
      AND OLD."lease_token" = current_mode."lease_token"
      AND NEW."status" IN ('pending', 'bound')
    ) THEN
    RAISE EXCEPTION 'stripe_connect_test_operation_lease_conflict';
  END IF;

  UPDATE "stripe_connect_mode_onboarding_operations" SET
    "status" = NEW."status",
    "stripe_account_id" = NEW."stripe_account_id",
    "lease_token" = NEW."lease_token",
    "lease_expires_at" = NEW."lease_expires_at",
    "attempt_count" = NEW."attempt_count",
    "last_error" = NEW."last_error",
    "updated_at" = NEW."updated_at"
  WHERE "performer_id" = NEW."performer_id" AND "payment_mode" = 'test';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "stripe_connect_legacy_operation_test_mode_mirror"
  AFTER INSERT OR UPDATE ON "stripe_connect_onboarding_operations"
  FOR EACH ROW EXECUTE FUNCTION "sway_mirror_legacy_stripe_connect_operation_to_test_mode"();--> statement-breakpoint

CREATE FUNCTION "sway_mirror_legacy_performer_connect_to_test_binding"() RETURNS trigger AS $$
DECLARE
  current_binding "performer_stripe_connect_bindings"%ROWTYPE;
BEGIN
  SELECT * INTO current_binding
  FROM "performer_stripe_connect_bindings"
  WHERE "performer_id" = NEW."id" AND "payment_mode" = 'test'
  FOR UPDATE;

  IF FOUND AND NEW."stripe_connected_account_id" IS NULL THEN
    RAISE EXCEPTION 'stripe_connect_test_binding_clear_conflict';
  END IF;

  IF NEW."stripe_connected_account_id" IS NOT NULL THEN
    IF FOUND THEN
      IF current_binding."stripe_account_id" <> NEW."stripe_connected_account_id" THEN
        RAISE EXCEPTION 'stripe_connect_test_binding_identity_conflict';
      END IF;
      UPDATE "performer_stripe_connect_bindings" SET
        "payment_account_status" = NEW."payment_account_status",
        "charges_enabled" = NEW."charges_enabled",
        "payouts_enabled" = NEW."payouts_enabled",
        "status_checked_at" = NEW."stripe_connect_status_checked_at",
        "updated_at" = NEW."updated_at"
      WHERE "performer_id" = NEW."id" AND "payment_mode" = 'test';
    ELSE
      INSERT INTO "performer_stripe_connect_bindings" (
        "performer_id",
        "payment_mode",
        "stripe_account_id",
        "payment_account_status",
        "charges_enabled",
        "payouts_enabled",
        "status_checked_at",
        "created_at",
        "updated_at"
      ) VALUES (
        NEW."id",
        'test',
        NEW."stripe_connected_account_id",
        NEW."payment_account_status",
        NEW."charges_enabled",
        NEW."payouts_enabled",
        NEW."stripe_connect_status_checked_at",
        NEW."created_at",
        NEW."updated_at"
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "performers_legacy_connect_test_binding_mirror"
  AFTER INSERT OR UPDATE OF
    "stripe_connected_account_id",
    "payment_account_status",
    "charges_enabled",
    "payouts_enabled",
    "stripe_connect_status_checked_at"
  ON "performers"
  FOR EACH ROW EXECUTE FUNCTION "sway_mirror_legacy_performer_connect_to_test_binding"();--> statement-breakpoint

-- All Connect state that predates this migration was created with Sway's
-- test credentials. Preserve that identity explicitly before any live lane
-- can be enabled. The legacy mirror triggers are deliberately installed first:
-- combined with the migration-held table locks, there is no old-writer gap
-- between this snapshot and compatibility mirroring.
INSERT INTO "performer_stripe_connect_bindings" (
  "performer_id",
  "payment_mode",
  "stripe_account_id",
  "payment_account_status",
  "charges_enabled",
  "payouts_enabled",
  "status_checked_at",
  "created_at",
  "updated_at"
)
SELECT
  p."id",
  'test',
  COALESCE(p."stripe_connected_account_id", o."stripe_account_id"),
  p."payment_account_status",
  p."charges_enabled",
  p."payouts_enabled",
  p."stripe_connect_status_checked_at",
  p."created_at",
  p."updated_at"
FROM "performers" p
LEFT JOIN "stripe_connect_onboarding_operations" o
  ON o."performer_id" = p."id"
WHERE COALESCE(p."stripe_connected_account_id", o."stripe_account_id") IS NOT NULL
ON CONFLICT ("performer_id", "payment_mode") DO NOTHING;--> statement-breakpoint

INSERT INTO "stripe_connect_mode_onboarding_operations" (
  "performer_id",
  "payment_mode",
  "owner_user_id",
  "operation_key",
  "status",
  "stripe_account_id",
  "lease_token",
  "lease_expires_at",
  "attempt_count",
  "last_error",
  "created_at",
  "updated_at"
)
SELECT
  "performer_id",
  'test',
  "owner_user_id",
  "operation_key",
  "status",
  "stripe_account_id",
  "lease_token",
  "lease_expires_at",
  "attempt_count",
  "last_error",
  "created_at",
  "updated_at"
FROM "stripe_connect_onboarding_operations"
ON CONFLICT ("performer_id", "payment_mode") DO NOTHING;--> statement-breakpoint

-- A durable operation must always be processed in the same provider
-- environment as its payment. The application also checks this invariant;
-- the database guard prevents a missed call site or stale worker from
-- crossing the test/live boundary.
CREATE FUNCTION "sway_enforce_live_room_payment_operation_mode"() RETURNS trigger AS $$
DECLARE
  durable_payment_mode text;
BEGIN
  SELECT "payment_mode"
    INTO durable_payment_mode
    FROM "payments"
    WHERE "id" = NEW."payment_id"
    FOR SHARE;

  IF durable_payment_mode IS NULL THEN
    RAISE EXCEPTION 'payment % does not exist', NEW."payment_id";
  END IF;

  IF NEW."payment_mode" <> durable_payment_mode THEN
    RAISE EXCEPTION 'payment operation mode % does not match payment mode %',
      NEW."payment_mode", durable_payment_mode;
  END IF;

  IF TG_OP = 'UPDATE'
    AND (
      NEW."payment_id" IS DISTINCT FROM OLD."payment_id"
      OR NEW."payment_mode" IS DISTINCT FROM OLD."payment_mode"
    ) THEN
    RAISE EXCEPTION 'payment operation identity is immutable';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "live_room_payment_operations_mode_guard"
  BEFORE INSERT OR UPDATE OF "payment_id", "payment_mode"
  ON "live_room_payment_operations"
  FOR EACH ROW EXECUTE FUNCTION "sway_enforce_live_room_payment_operation_mode"();--> statement-breakpoint

CREATE FUNCTION "sway_enforce_payment_mode_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."payment_mode" IS DISTINCT FROM OLD."payment_mode" THEN
    RAISE EXCEPTION 'payment mode is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER "payments_mode_immutable"
  BEFORE UPDATE OF "payment_mode"
  ON "payments"
  FOR EACH ROW EXECUTE FUNCTION "sway_enforce_payment_mode_immutable"();
