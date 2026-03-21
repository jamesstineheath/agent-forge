CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"prd_id" text NOT NULL,
	"prd_title" text NOT NULL,
	"target_repo" text NOT NULL,
	"branch_name" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"acceptance_criteria" text NOT NULL,
	"kg_context" jsonb,
	"affected_files" jsonb,
	"estimated_budget" real,
	"actual_cost" real,
	"max_duration_minutes" integer DEFAULT 60,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_log" text,
	"pr_number" integer,
	"pr_url" text,
	"workflow_run_id" text,
	"retry_count" integer DEFAULT 0,
	"prd_rank" integer,
	"progress" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "spike_metadata" json;--> statement-breakpoint
CREATE INDEX "idx_plans_status" ON "plans" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_plans_target_repo" ON "plans" USING btree ("target_repo");--> statement-breakpoint
CREATE INDEX "idx_plans_prd_id" ON "plans" USING btree ("prd_id");--> statement-breakpoint
CREATE INDEX "idx_plans_status_target_repo" ON "plans" USING btree ("status","target_repo");