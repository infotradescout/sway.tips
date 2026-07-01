CREATE TABLE "performer_library_tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL,
  "source_key" text NOT NULL,
  "source_label" text NOT NULL,
  "external_track_id" text NOT NULL,
  "title" text NOT NULL,
  "artist" text NOT NULL,
  "album" text,
  "artwork_url" text,
  "searchable_text" text NOT NULL,
  "metadata" jsonb,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performer_library_tracks" ADD CONSTRAINT "performer_library_tracks_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "performer_library_tracks_performer_source_track_idx" ON "performer_library_tracks" USING btree ("performer_id","source_key","external_track_id");
--> statement-breakpoint
CREATE INDEX "performer_library_tracks_performer_search_idx" ON "performer_library_tracks" USING btree ("performer_id","last_seen_at");
