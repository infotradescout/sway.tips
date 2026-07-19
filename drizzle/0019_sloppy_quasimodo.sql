CREATE TYPE "public"."attribution_source" AS ENUM('creator_direct', 'sway_promoted');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'ended');--> statement-breakpoint
CREATE TABLE "promotion_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"performer_id" uuid NOT NULL,
	"campaign_code" text NOT NULL,
	"label" text NOT NULL,
	"commission_bps" integer NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "attribution_source" "attribution_source" DEFAULT 'creator_direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "commission_bps_applied" integer;--> statement-breakpoint
ALTER TABLE "promotion_campaigns" ADD CONSTRAINT "promotion_campaigns_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_campaign_id_promotion_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."promotion_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "promotion_campaigns_code_idx" ON "promotion_campaigns" USING btree ("campaign_code");--> statement-breakpoint
CREATE INDEX "promotion_campaigns_performer_status_idx" ON "promotion_campaigns" USING btree ("performer_id","status");--> statement-breakpoint
CREATE INDEX "payments_campaign_id_idx" ON "payments" USING btree ("campaign_id");
