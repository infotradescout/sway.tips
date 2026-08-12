ALTER TABLE "client_pending_actions" ADD COLUMN "owner_token" text;--> statement-breakpoint
ALTER TABLE "client_pending_actions" ADD COLUMN "owner_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "client_pending_actions" ADD COLUMN "owner_lease_expires_at" timestamp with time zone;