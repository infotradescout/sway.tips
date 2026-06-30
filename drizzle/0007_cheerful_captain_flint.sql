CREATE TABLE "performer_login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_email" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"send_count" integer DEFAULT 1 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requester_ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "performer_login_challenges" ADD CONSTRAINT "performer_login_challenges_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "performer_login_challenges_token_hash_idx" ON "performer_login_challenges" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "performer_login_challenges_actor_expires_idx" ON "performer_login_challenges" USING btree ("actor_user_id","expires_at");--> statement-breakpoint
CREATE INDEX "performer_login_challenges_request_bucket_idx" ON "performer_login_challenges" USING btree ("requester_ip_hash","target_email","requested_at");
