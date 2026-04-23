CREATE TYPE "public"."agent_run_status" AS ENUM('running', 'success', 'failed', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."agent_trigger" AS ENUM('scheduled', 'http', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."automation_candidate_status" AS ENUM('proposed', 'approved', 'rejected', 'built', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."automation_deployment_status" AS ENUM('deployed', 'activated', 'deactivated', 'removed');--> statement-breakpoint
CREATE TYPE "public"."marketplace_update_status" AS ENUM('pending', 'accepted', 'skipped');--> statement-breakpoint
CREATE TABLE "agent_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"version" text NOT NULL,
	"description" text NOT NULL,
	"output_schema_name" text NOT NULL,
	"default_memory" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_definitions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "agent_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_slug" text NOT NULL,
	"name" text NOT NULL,
	"scope_domain_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"output_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schedule_cron" text,
	"memory" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_instances_definition_slug_name_unique" UNIQUE("definition_slug","name"),
	CONSTRAINT "agent_instances_locale_allowed" CHECK ("agent_instances"."locale" IN ('en', 'pl', 'auto'))
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"definition_slug" text NOT NULL,
	"instance_id" uuid NOT NULL,
	"trigger" "agent_trigger" NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" jsonb,
	"skills_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"status" "agent_run_status" NOT NULL,
	"error_class" "error_class",
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"surfacer_run_id" uuid NOT NULL,
	"source_page_refs" jsonb NOT NULL,
	"proposal" jsonb NOT NULL,
	"status" "automation_candidate_status" DEFAULT 'proposed' NOT NULL,
	"rationale" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"builder_run_id" uuid NOT NULL,
	"n8n_workflow_id" text NOT NULL,
	"skills_used_snapshot" jsonb NOT NULL,
	"status" "automation_deployment_status" DEFAULT 'deployed' NOT NULL,
	"deployed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"last_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_deployments_n8n_workflow_id_unique" UNIQUE("n8n_workflow_id")
);
--> statement-breakpoint
CREATE TABLE "marketplace_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"marketplace_source" text NOT NULL,
	"release_tag" text NOT NULL,
	"target_commitish" text NOT NULL,
	"tree_sha" text NOT NULL,
	"skills_diff" jsonb NOT NULL,
	"status" "marketplace_update_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_updates_source_release_tag_unique" UNIQUE("marketplace_source","release_tag")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_instance_id_agent_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."agent_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_candidates" ADD CONSTRAINT "automation_candidates_surfacer_run_id_agent_runs_id_fk" FOREIGN KEY ("surfacer_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_candidates" ADD CONSTRAINT "automation_candidates_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_deployments" ADD CONSTRAINT "automation_deployments_candidate_id_automation_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."automation_candidates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_deployments" ADD CONSTRAINT "automation_deployments_builder_run_id_agent_runs_id_fk" FOREIGN KEY ("builder_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_updates" ADD CONSTRAINT "marketplace_updates_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_instance_id_started_at_idx" ON "agent_runs" USING btree ("instance_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_definition_slug_started_at_idx" ON "agent_runs" USING btree ("definition_slug","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_candidates_status_idx" ON "automation_candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_candidates_surfacer_run_id_idx" ON "automation_candidates" USING btree ("surfacer_run_id");--> statement-breakpoint
CREATE INDEX "automation_deployments_status_idx" ON "automation_deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "automation_deployments_candidate_id_idx" ON "automation_deployments" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "marketplace_updates_status_idx" ON "marketplace_updates" USING btree ("status");--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_citations" ADD CONSTRAINT "page_citations_compiled_by_run_id_agent_runs_id_fk" FOREIGN KEY ("compiled_by_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;