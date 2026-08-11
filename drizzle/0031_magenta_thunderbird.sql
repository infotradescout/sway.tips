CREATE TABLE "stripe_connect_onboarding_operations" (
	"performer_id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_account_id" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_connect_onboarding_operations_status_allowed" CHECK ("stripe_connect_onboarding_operations"."status" in ('pending', 'provisioning', 'bound')),
	CONSTRAINT "stripe_connect_onboarding_operations_attempt_count_valid" CHECK ("stripe_connect_onboarding_operations"."attempt_count" >= 0),
	CONSTRAINT "stripe_connect_onboarding_operations_lease_consistent" CHECK ((
      ("stripe_connect_onboarding_operations"."status" = 'provisioning' and "stripe_connect_onboarding_operations"."lease_token" is not null and "stripe_connect_onboarding_operations"."lease_expires_at" is not null)
      or
      ("stripe_connect_onboarding_operations"."status" <> 'provisioning' and "stripe_connect_onboarding_operations"."lease_token" is null and "stripe_connect_onboarding_operations"."lease_expires_at" is null)
    )),
	CONSTRAINT "stripe_connect_onboarding_operations_bound_account_required" CHECK ("stripe_connect_onboarding_operations"."status" <> 'bound' or "stripe_connect_onboarding_operations"."stripe_account_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "stripe_connect_onboarding_operations" ADD CONSTRAINT "stripe_connect_onboarding_operations_performer_id_performers_id_fk" FOREIGN KEY ("performer_id") REFERENCES "public"."performers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stripe_connect_onboarding_operations" ADD CONSTRAINT "stripe_connect_onboarding_operations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_connect_onboarding_operations_key_idx" ON "stripe_connect_onboarding_operations" USING btree ("operation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "stripe_connect_onboarding_operations_account_idx" ON "stripe_connect_onboarding_operations" USING btree ("stripe_account_id") WHERE "stripe_connect_onboarding_operations"."stripe_account_id" is not null;