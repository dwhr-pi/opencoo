CREATE TABLE "prompt_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"instance_id" uuid,
	"prompt_name" text NOT NULL,
	"locale" text NOT NULL,
	"body" text NOT NULL,
	"overrides_version" text NOT NULL,
	"baseline_version" text NOT NULL,
	"updated_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_overrides_scope_unique" UNIQUE NULLS NOT DISTINCT("domain_id","instance_id","prompt_name","locale"),
	CONSTRAINT "prompt_overrides_locale_allowed" CHECK ("prompt_overrides"."locale" IN ('en', 'pl')),
	CONSTRAINT "prompt_overrides_body_len" CHECK (length("prompt_overrides"."body") <= 100000),
	CONSTRAINT "prompt_overrides_prompt_name_allowed" CHECK ("prompt_overrides"."prompt_name" IN ('classifier','compiler','heartbeat','lint','chat','surfacer','builder','worldview-domain','worldview-company'))
);
--> statement-breakpoint
ALTER TABLE "prompt_overrides" ADD CONSTRAINT "prompt_overrides_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_overrides" ADD CONSTRAINT "prompt_overrides_instance_id_agent_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."agent_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_overrides" ADD CONSTRAINT "prompt_overrides_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;