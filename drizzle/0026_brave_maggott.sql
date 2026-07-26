CREATE TYPE "public"."performer_event_status" AS ENUM('draft', 'published', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."performer_event_visibility" AS ENUM('public', 'unlisted');--> statement-breakpoint
CREATE TABLE "performer_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"performer_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"created_by_actor_user_id" uuid NOT NULL,
	"last_mutation_actor_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"time_zone" text NOT NULL,
	"location_name" text,
	"location_address" text,
	"city" text,
	"location_is_tba" boolean DEFAULT false NOT NULL,
	"cover_image_url" text,
	"external_ticket_url" text,
	"external_ticket_label" text,
	"visibility" "performer_event_visibility" DEFAULT 'unlisted' NOT NULL,
	"status" "performer_event_status" DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "performer_events_ends_after_starts" CHECK ("performer_events"."ends_at" IS NULL OR "performer_events"."ends_at" > "performer_events"."starts_at"),
	CONSTRAINT "performer_events_published_has_timestamp" CHECK ("performer_events"."status" <> 'published' OR "performer_events"."published_at" IS NOT NULL),
	CONSTRAINT "performer_events_published_has_external_ticket" CHECK ("performer_events"."status" <> 'published' OR "performer_events"."external_ticket_url" IS NOT NULL),
	CONSTRAINT "performer_events_cancelled_has_timestamp" CHECK ("performer_events"."status" <> 'cancelled' OR "performer_events"."cancelled_at" IS NOT NULL),
	CONSTRAINT "performer_events_cancelled_was_published" CHECK ("performer_events"."status" <> 'cancelled' OR "performer_events"."published_at" IS NOT NULL),
	CONSTRAINT "performer_events_cancelled_has_reason" CHECK ("performer_events"."status" <> 'cancelled' OR ("performer_events"."cancellation_reason" IS NOT NULL AND length(trim("performer_events"."cancellation_reason")) > 0)),
	CONSTRAINT "performer_events_cover_image_uses_https" CHECK ("performer_events"."cover_image_url" IS NULL OR "performer_events"."cover_image_url" ~* '^https://[^[:space:]]+$'),
	CONSTRAINT "performer_events_external_ticket_uses_https" CHECK ("performer_events"."external_ticket_url" IS NULL OR "performer_events"."external_ticket_url" ~* '^https://[^[:space:]]+$'),
	CONSTRAINT "performer_events_external_ticket_shape" CHECK (("performer_events"."external_ticket_url" IS NULL AND "performer_events"."external_ticket_label" IS NULL) OR ("performer_events"."external_ticket_url" IS NOT NULL AND "performer_events"."external_ticket_label" IS NOT NULL)),
	CONSTRAINT "performer_events_external_ticket_label_allowed" CHECK ("performer_events"."external_ticket_label" IS NULL OR "performer_events"."external_ticket_label" IN ('Get tickets', 'RSVP', 'View details'))
);
--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_created_by_actor_user_id_users_id_fk" FOREIGN KEY ("created_by_actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performer_events" ADD CONSTRAINT "performer_events_last_mutation_actor_user_id_users_id_fk" FOREIGN KEY ("last_mutation_actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "performer_events_performer_client_request_idx" ON "performer_events" USING btree ("performer_id","client_request_id");--> statement-breakpoint
CREATE INDEX "performer_events_performer_status_start_idx" ON "performer_events" USING btree ("performer_id","status","starts_at");--> statement-breakpoint
CREATE INDEX "performer_events_public_status_visibility_start_idx" ON "performer_events" USING btree ("status","visibility","starts_at");
