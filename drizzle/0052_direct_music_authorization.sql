CREATE TABLE "direct_music_credentials" (
  "connection_id" uuid PRIMARY KEY REFERENCES "performer_music_source_connections"("id") ON DELETE CASCADE,
  "actor_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "performer_id" uuid NOT NULL REFERENCES "performers"("id"),
  "revision" uuid NOT NULL,
  "sealed_tokens" text NOT NULL,
  "selected_device_id" text,
  "cooldown_until" timestamptz,
  "command_lease_id" uuid,
  "command_lease_until" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "direct_music_credentials_performer_idx" ON "direct_music_credentials" ("performer_id");
--> statement-breakpoint
CREATE TABLE "direct_music_oauth_attempts" (
  "state_hash" text PRIMARY KEY,
  "actor_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "performer_id" uuid NOT NULL REFERENCES "performers"("id"),
  "browser_hash" text NOT NULL,
  "sealed_verifier" text NOT NULL,
  "expected_connection_id" uuid,
  "expected_revision" uuid,
  "expires_at" timestamptz NOT NULL,
  "claimed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "direct_music_oauth_expiry_idx" ON "direct_music_oauth_attempts" ("expires_at");
--> statement-breakpoint
CREATE TABLE "direct_music_commands" (
  "id" uuid PRIMARY KEY,
  "connection_id" uuid NOT NULL REFERENCES "performer_music_source_connections"("id") ON DELETE CASCADE,
  "actor_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "performer_id" uuid NOT NULL REFERENCES "performers"("id"),
  "request_hash" text NOT NULL,
  "status" text NOT NULL,
  "code" text,
  "message" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX "direct_music_commands_connection_idx" ON "direct_music_commands" ("connection_id");
