CREATE TABLE "performer_music_source_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL,
  "provider_key" text NOT NULL,
  "provider_display_name" text NOT NULL,
  "source_mode" text NOT NULL,
  "connection_status" text DEFAULT 'not_connected' NOT NULL,
  "auth_status" text DEFAULT 'not_connected' NOT NULL,
  "capability_snapshot" jsonb NOT NULL,
  "external_account_id" text,
  "external_account_label" text,
  "token_vault_ref" text,
  "connected_at" timestamp with time zone,
  "disconnected_at" timestamp with time zone,
  "last_capability_checked_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performer_music_source_connections" ADD CONSTRAINT "performer_music_source_connections_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "performer_music_source_connections_provider_account_idx" ON "performer_music_source_connections" USING btree ("performer_id","provider_key","external_account_id");
--> statement-breakpoint
CREATE INDEX "performer_music_source_connections_provider_status_idx" ON "performer_music_source_connections" USING btree ("performer_id","provider_key","connection_status");
