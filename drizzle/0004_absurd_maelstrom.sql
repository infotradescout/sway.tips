ALTER TABLE "gig_sessions" ADD COLUMN "owner_actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD COLUMN "last_mutation_actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "last_mutation_actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD CONSTRAINT "gig_sessions_owner_actor_user_id_users_id_fk" FOREIGN KEY ("owner_actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gig_sessions" ADD CONSTRAINT "gig_sessions_last_mutation_actor_user_id_users_id_fk" FOREIGN KEY ("last_mutation_actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_boosts" ADD CONSTRAINT "request_boosts_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_last_mutation_actor_user_id_users_id_fk" FOREIGN KEY ("last_mutation_actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;