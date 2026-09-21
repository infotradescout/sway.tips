CREATE TABLE "playback_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gig_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"client_command_id" text NOT NULL,
	"source_key" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"result" jsonb,
	"error_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_commands_status_valid" CHECK (
    "playback_commands"."status" in ('queued', 'claimed', 'succeeded', 'failed', 'expired')
  ),
	CONSTRAINT "playback_commands_action_valid" CHECK (
    "playback_commands"."action" in ('load', 'play', 'pause', 'stop', 'cue', 'next', 'previous')
  ),
	CONSTRAINT "playback_commands_source_key_valid" CHECK (length(trim("playback_commands"."source_key")) > 0),
	CONSTRAINT "playback_commands_client_command_id_valid" CHECK (length(trim("playback_commands"."client_command_id")) > 0)
);
--> statement-breakpoint
CREATE TABLE "playback_states" (
	"gig_id" uuid PRIMARY KEY NOT NULL,
	"performer_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"transport" text NOT NULL,
	"bridge_instance_id" text NOT NULL,
	"connection_status" text DEFAULT 'connected' NOT NULL,
	"deck" integer,
	"track_title" text,
	"track_artist" text,
	"track_path" text,
	"external_track_id" text,
	"playing" boolean,
	"position_ms" integer,
	"duration_ms" integer,
	"bpm_times_100" integer,
	"revision" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playback_states_connection_status_valid" CHECK (
    "playback_states"."connection_status" in ('connected', 'degraded', 'disconnected')
  ),
	CONSTRAINT "playback_states_deck_valid" CHECK ("playback_states"."deck" is null or ("playback_states"."deck" >= 1 and "playback_states"."deck" <= 8)),
	CONSTRAINT "playback_states_position_valid" CHECK ("playback_states"."position_ms" is null or "playback_states"."position_ms" >= 0),
	CONSTRAINT "playback_states_duration_valid" CHECK ("playback_states"."duration_ms" is null or "playback_states"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "performer_sessions" ADD COLUMN "session_type" text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE "performer_sessions" ADD COLUMN "gig_id" uuid;--> statement-breakpoint
ALTER TABLE "performer_sessions" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "playback_commands" ADD CONSTRAINT "playback_commands_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_commands" ADD CONSTRAINT "playback_commands_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_commands" ADD CONSTRAINT "playback_commands_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_states" ADD CONSTRAINT "playback_states_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playback_states" ADD CONSTRAINT "playback_states_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playback_commands_gig_client_command_idx" ON "playback_commands" USING btree ("gig_id","client_command_id");--> statement-breakpoint
CREATE INDEX "playback_commands_claim_queue_idx" ON "playback_commands" USING btree ("gig_id","source_key","status","created_at");--> statement-breakpoint
CREATE INDEX "playback_states_performer_observed_idx" ON "playback_states" USING btree ("performer_id","observed_at");--> statement-breakpoint
ALTER TABLE "performer_sessions" ADD CONSTRAINT "performer_sessions_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "performer_sessions_actor_type_gig_idx" ON "performer_sessions" USING btree ("actor_user_id","session_type","gig_id","expires_at");--> statement-breakpoint
ALTER TABLE "performer_sessions" ADD CONSTRAINT "performer_sessions_session_type_valid" CHECK (
    "performer_sessions"."session_type" in ('browser', 'control_bridge')
  );--> statement-breakpoint
ALTER TABLE "performer_sessions" ADD CONSTRAINT "performer_sessions_bridge_gig_scope_valid" CHECK (
    ("performer_sessions"."session_type" = 'browser') or ("performer_sessions"."session_type" = 'control_bridge' and "performer_sessions"."gig_id" is not null)
  );
