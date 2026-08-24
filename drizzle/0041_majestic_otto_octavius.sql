CREATE TABLE "audio_object_cleanup_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"upload_session_id" uuid,
	"storage_provider" text NOT NULL,
	"storage_bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"provider_upload_id" text,
	"cleanup_reason" text NOT NULL,
	"cleanup_status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"last_error" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "audio_object_cleanup_receipts_reason_allowed" CHECK ("audio_object_cleanup_receipts"."cleanup_reason" in ('orphaned_owner_initiation', 'orphaned_candidate_initiation', 'owner_integrity_validation_failed', 'candidate_technical_validation_failed')),
	CONSTRAINT "audio_object_cleanup_receipts_status_allowed" CHECK ("audio_object_cleanup_receipts"."cleanup_status" in ('pending', 'completed')),
	CONSTRAINT "audio_object_cleanup_receipts_attempts_valid" CHECK ("audio_object_cleanup_receipts"."attempt_count" > 0),
	CONSTRAINT "audio_object_cleanup_receipts_error_required" CHECK (length(btrim("audio_object_cleanup_receipts"."last_error")) > 0),
	CONSTRAINT "audio_object_cleanup_receipts_completion_coherent" CHECK (("audio_object_cleanup_receipts"."cleanup_status" = 'pending' and "audio_object_cleanup_receipts"."completed_at" is null) or ("audio_object_cleanup_receipts"."cleanup_status" = 'completed' and "audio_object_cleanup_receipts"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "audio_object_cleanup_receipts" ADD CONSTRAINT "audio_object_cleanup_receipts_project_id_audio_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."audio_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_object_cleanup_receipts" ADD CONSTRAINT "audio_object_cleanup_receipts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audio_object_cleanup_receipts_storage_object_idx" ON "audio_object_cleanup_receipts" USING btree ("storage_provider","storage_bucket","storage_key");--> statement-breakpoint
CREATE INDEX "audio_object_cleanup_receipts_pending_requested_idx" ON "audio_object_cleanup_receipts" USING btree ("cleanup_status","requested_at");--> statement-breakpoint
CREATE INDEX "audio_object_cleanup_receipts_project_requested_idx" ON "audio_object_cleanup_receipts" USING btree ("project_id","requested_at");