CREATE TABLE "moderation_mutation_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_hash" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"intent_fingerprint" text NOT NULL,
	"first_response_status" integer,
	"first_response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_mutation_keys_action_type_allowed" CHECK ("moderation_mutation_keys"."action_type" in ('block', 'block_revoke'))
);
--> statement-breakpoint
ALTER TABLE "moderation_mutation_keys" ADD CONSTRAINT "moderation_mutation_keys_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_mutation_keys_key_hash_idx" ON "moderation_mutation_keys" USING btree ("key_hash");--> statement-breakpoint
UPDATE "active_blocks" SET "revoked_at" = NULL WHERE "status" = 'active' AND "revoked_at" IS NOT NULL;--> statement-breakpoint
UPDATE "active_blocks" SET "revoked_at" = COALESCE("updated_at", "created_at", NOW()) WHERE "status" = 'revoked' AND "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "active_blocks" ADD CONSTRAINT "active_blocks_lifecycle_shape" CHECK (("active_blocks"."status" = 'active' and "active_blocks"."revoked_at" is null) or ("active_blocks"."status" = 'revoked' and "active_blocks"."revoked_at" is not null));
