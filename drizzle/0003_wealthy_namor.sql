ALTER TABLE "gig_sessions" ADD COLUMN "runtime_session_state" jsonb;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD COLUMN "runtime_boost_state" jsonb;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "runtime_request_state" jsonb;