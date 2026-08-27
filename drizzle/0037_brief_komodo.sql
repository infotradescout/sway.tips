CREATE TABLE "music_release_report_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"note" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "music_release_report_events_type_allowed" CHECK ("music_release_report_events"."event_type" in ('submitted', 'dismissed', 'escalated', 'resolved')),
	CONSTRAINT "music_release_report_events_note_valid" CHECK (char_length(trim("music_release_report_events"."note")) between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "music_release_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "music_release_reports_reason_allowed" CHECK ("music_release_reports"."reason" in ('copied_lyrics', 'unauthorized_voice', 'unlicensed_sample', 'missing_commercial_rights', 'incorrect_creation_credit', 'spam_or_duplicate', 'fake_engagement', 'impersonation')),
	CONSTRAINT "music_release_reports_status_allowed" CHECK ("music_release_reports"."status" in ('pending', 'dismissed', 'escalated', 'resolved')),
	CONSTRAINT "music_release_reports_details_valid" CHECK (char_length(trim("music_release_reports"."details")) between 40 and 2000)
);
--> statement-breakpoint
ALTER TABLE "music_recordings" ADD COLUMN "lyrics_authorship" text DEFAULT 'not_declared' NOT NULL;--> statement-breakpoint
ALTER TABLE "music_recordings" ADD COLUMN "composition_authorship" text DEFAULT 'not_declared' NOT NULL;--> statement-breakpoint
ALTER TABLE "music_recordings" ADD COLUMN "vocal_performance" text DEFAULT 'not_declared' NOT NULL;--> statement-breakpoint
ALTER TABLE "music_recordings" ADD COLUMN "production_method" text DEFAULT 'not_declared' NOT NULL;--> statement-breakpoint
ALTER TABLE "music_recordings" ADD COLUMN "lyrics_excerpt" text;--> statement-breakpoint
ALTER TABLE "music_release_report_events" ADD CONSTRAINT "music_release_report_events_report_id_music_release_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."music_release_reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_release_report_events" ADD CONSTRAINT "music_release_report_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_release_reports" ADD CONSTRAINT "music_release_reports_release_id_music_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."music_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "music_release_reports" ADD CONSTRAINT "music_release_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "music_release_report_events_report_created_idx" ON "music_release_report_events" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "music_release_report_events_single_submitted_idx" ON "music_release_report_events" USING btree ("report_id") WHERE "music_release_report_events"."event_type" = 'submitted';--> statement-breakpoint
CREATE INDEX "music_release_reports_release_created_idx" ON "music_release_reports" USING btree ("release_id","created_at");--> statement-breakpoint
CREATE INDEX "music_release_reports_status_created_idx" ON "music_release_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "music_release_reports_active_identity_idx" ON "music_release_reports" USING btree ("release_id","reporter_user_id","reason") WHERE "music_release_reports"."status" in ('pending', 'escalated');--> statement-breakpoint
ALTER TABLE "music_recordings" ADD CONSTRAINT "music_recordings_lyrics_authorship_allowed" CHECK ("music_recordings"."lyrics_authorship" in ('not_declared', 'human', 'human_ai_assisted', 'generated', 'instrumental'));--> statement-breakpoint
ALTER TABLE "music_recordings" ADD CONSTRAINT "music_recordings_composition_authorship_allowed" CHECK ("music_recordings"."composition_authorship" in ('not_declared', 'human', 'human_ai_assisted', 'generated'));--> statement-breakpoint
ALTER TABLE "music_recordings" ADD CONSTRAINT "music_recordings_vocal_performance_allowed" CHECK ("music_recordings"."vocal_performance" in ('not_declared', 'human', 'virtual_original', 'licensed_replica', 'mixed', 'instrumental'));--> statement-breakpoint
ALTER TABLE "music_recordings" ADD CONSTRAINT "music_recordings_production_method_allowed" CHECK ("music_recordings"."production_method" in ('not_declared', 'human', 'ai_assisted', 'generated', 'mixed'));--> statement-breakpoint
ALTER TABLE "music_recordings" ADD CONSTRAINT "music_recordings_lyrics_excerpt_valid" CHECK ("music_recordings"."lyrics_excerpt" is null or (char_length(trim("music_recordings"."lyrics_excerpt")) between 1 and 500));
--> statement-breakpoint
CREATE FUNCTION "sway_guard_music_release_report_mutation"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Music release reports are retained audit records and cannot be deleted.';
  END IF;
  IF NEW.release_id <> OLD.release_id
    OR NEW.reporter_user_id <> OLD.reporter_user_id
    OR NEW.reason <> OLD.reason
    OR NEW.details <> OLD.details
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Music release report origin and evidence are immutable.';
  END IF;
  IF OLD.status IN ('dismissed', 'resolved')
    OR NEW.status = OLD.status
    OR (OLD.status = 'pending' AND NEW.status NOT IN ('dismissed', 'escalated', 'resolved'))
    OR (OLD.status = 'escalated' AND NEW.status NOT IN ('dismissed', 'resolved')) THEN
    RAISE EXCEPTION 'Music release report status transition is invalid.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "music_release_reports_guarded" BEFORE UPDATE OR DELETE ON "music_release_reports" FOR EACH ROW EXECUTE FUNCTION "sway_guard_music_release_report_mutation"();
--> statement-breakpoint
CREATE TRIGGER "music_release_report_events_append_only" BEFORE UPDATE OR DELETE ON "music_release_report_events" FOR EACH ROW EXECUTE FUNCTION "sway_reject_immutable_audio_mutation"();
