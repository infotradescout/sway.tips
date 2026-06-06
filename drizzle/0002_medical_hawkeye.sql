CREATE TABLE "active_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"normalized_value" text NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "active_blocks" ADD CONSTRAINT "active_blocks_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "active_blocks_scope_value_status_idx" ON "active_blocks" USING btree ("scope","normalized_value","status");--> statement-breakpoint
CREATE INDEX "active_blocks_scope_value_idx" ON "active_blocks" USING btree ("scope","normalized_value");