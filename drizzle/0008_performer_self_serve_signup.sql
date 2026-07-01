ALTER TABLE "users" ADD COLUMN "password_hash" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "performers" ADD COLUMN "is_active" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "performers" ALTER COLUMN "handle" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "performer_login_challenges" ALTER COLUMN "actor_user_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "performer_login_challenges" ADD COLUMN "challenge_type" text DEFAULT 'login' NOT NULL;
--> statement-breakpoint
ALTER TABLE "performer_login_challenges" ADD COLUMN "challenge_metadata" jsonb;
--> statement-breakpoint
DROP INDEX IF EXISTS "performers_handle_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_performers_handle" ON "performers" USING btree ("handle") WHERE "handle" IS NOT NULL;
