CREATE TABLE "direct_music_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"code" text,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "direct_music_credentials" (
	"connection_id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"revision" uuid NOT NULL,
	"sealed_tokens" text NOT NULL,
	"selected_device_id" text,
	"cooldown_until" timestamp with time zone,
	"command_lease_id" uuid,
	"command_lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "direct_music_oauth_attempts" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"performer_id" uuid NOT NULL,
	"browser_hash" text NOT NULL,
	"sealed_verifier" text NOT NULL,
	"expected_connection_id" uuid,
	"expected_revision" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "direct_music_commands" ADD CONSTRAINT "direct_music_commands_connection_id_performer_music_source_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."performer_music_source_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "direct_music_commands" ADD CONSTRAINT "direct_music_commands_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "direct_music_commands" ADD CONSTRAINT "direct_music_commands_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "direct_music_credentials" ADD CONSTRAINT "direct_music_credentials_connection_id_performer_music_source_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."performer_music_source_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "direct_music_credentials" ADD CONSTRAINT "direct_music_credentials_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "direct_music_credentials" ADD CONSTRAINT "direct_music_credentials_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "direct_music_oauth_attempts" ADD CONSTRAINT "direct_music_oauth_attempts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "direct_music_oauth_attempts" ADD CONSTRAINT "direct_music_oauth_attempts_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "direct_music_commands_connection_idx" ON "direct_music_commands" USING btree ("connection_id");
--> statement-breakpoint
CREATE INDEX "direct_music_credentials_performer_idx" ON "direct_music_credentials" USING btree ("performer_id");
--> statement-breakpoint
CREATE INDEX "direct_music_oauth_expiry_idx" ON "direct_music_oauth_attempts" USING btree ("expires_at");
