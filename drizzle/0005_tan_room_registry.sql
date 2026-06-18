CREATE TABLE "active_room_registry" (
	"gig_id" uuid PRIMARY KEY NOT NULL,
	"performer_id" uuid NOT NULL,
	"owner_actor_user_id" uuid,
	"talent_name" text DEFAULT '' NOT NULL,
	"talent_role" text DEFAULT 'Performer' NOT NULL,
	"route_path" text NOT NULL,
	"registry_status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "active_room_registry" ADD CONSTRAINT "active_room_registry_gig_id_gig_sessions_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gig_sessions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "active_room_registry" ADD CONSTRAINT "active_room_registry_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "active_room_registry" ADD CONSTRAINT "active_room_registry_owner_actor_user_id_users_id_fk" FOREIGN KEY ("owner_actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "active_room_registry_status_activity_idx" ON "active_room_registry" USING btree ("registry_status","last_activity_at");
--> statement-breakpoint
CREATE INDEX "active_room_registry_performer_idx" ON "active_room_registry" USING btree ("performer_id");
