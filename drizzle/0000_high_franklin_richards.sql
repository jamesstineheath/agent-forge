CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"target_repo" text NOT NULL,
	"status" text DEFAULT 'filed' NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"risk_level" text DEFAULT 'medium' NOT NULL,
	"complexity" text DEFAULT 'moderate' NOT NULL,
	"type" text,
	"source" jsonb NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggered_by" text,
	"complexity_hint" text,
	"expedite" boolean DEFAULT false,
	"triage_priority" text,
	"rank" integer,
	"handoff" jsonb,
	"execution" jsonb,
	"retry_budget" integer,
	"blocked_reason" text,
	"escalation" jsonb,
	"failure_category" text,
	"attribution" jsonb,
	"reasoning_metrics" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_work_items_status" ON "work_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_work_items_target_repo" ON "work_items" USING btree ("target_repo");--> statement-breakpoint
CREATE INDEX "idx_work_items_status_target_repo" ON "work_items" USING btree ("status","target_repo");--> statement-breakpoint
CREATE INDEX "idx_work_items_status_priority" ON "work_items" USING btree ("status","priority");