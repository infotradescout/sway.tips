CREATE TABLE "performer_setlist_tracks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "performer_id" uuid NOT NULL,
  "source_key" text DEFAULT 'manual' NOT NULL,
  "external_track_id" text,
  "title" text NOT NULL,
  "artist" text NOT NULL,
  "album" text,
  "artwork_url" text,
  "spotify_uri" text,
  "spotify_url" text,
  "searchable_text" text NOT NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performer_setlist_tracks" ADD CONSTRAINT "performer_setlist_tracks_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "performer_setlist_tracks_performer_search_idx" ON "performer_setlist_tracks" USING btree ("performer_id","added_at");
