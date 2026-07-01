CREATE TABLE "performer_library_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL,
  "source_key" text NOT NULL,
  "source_label" text NOT NULL,
  "sync_key_hash" text NOT NULL,
  "sync_key_preview" text NOT NULL,
  "connection_status" text DEFAULT 'active' NOT NULL,
  "last_synced_at" timestamp with time zone,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performer_library_sources" ADD CONSTRAINT "performer_library_sources_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "performer_library_sources_performer_source_idx" ON "performer_library_sources" USING btree ("performer_id","source_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "performer_library_sources_sync_key_hash_idx" ON "performer_library_sources" USING btree ("sync_key_hash");
