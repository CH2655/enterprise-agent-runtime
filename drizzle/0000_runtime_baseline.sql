CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'running', 'waiting_input', 'waiting_approval', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('started', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invocation_status" AS ENUM('started', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "agent_events" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" text NOT NULL,
	"node_id" text,
	"payload" jsonb NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_events_run_id_sequence_pk" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" "agent_run_status" NOT NULL,
	"input" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"event_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision" jsonb
);
--> statement-breakpoint
CREATE TABLE "evidence_records" (
	"id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"category" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"content" text NOT NULL,
	"locator" text,
	"hash" text,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_records_tenant_id_run_id_id_pk" PRIMARY KEY("tenant_id","run_id","id")
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"tenant_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"key" text NOT NULL,
	"run_id" uuid NOT NULL,
	"status" "idempotency_status" DEFAULT 'started' NOT NULL,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_tenant_id_tool_name_key_pk" PRIMARY KEY("tenant_id","tool_name","key")
);
--> statement-breakpoint
CREATE TABLE "risk_findings" (
	"id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"dimension" text NOT NULL,
	"level" text NOT NULL,
	"claim" text NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"confidence_basis_points" integer NOT NULL,
	"recommendation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_findings_tenant_id_run_id_id_pk" PRIMARY KEY("tenant_id","run_id","id")
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"access" text NOT NULL,
	"status" "invocation_status" NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"duration_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_tasks" ADD CONSTRAINT "approval_tasks_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_records" ADD CONSTRAINT "evidence_records_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_findings" ADD CONSTRAINT "risk_findings_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_events_run_timestamp_idx" ON "agent_events" USING btree ("run_id","timestamp");--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_status_idx" ON "agent_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_created_idx" ON "agent_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_tasks_run_unique" ON "approval_tasks" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "approval_tasks_tenant_status_idx" ON "approval_tasks" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "evidence_records_run_idx" ON "evidence_records" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "idempotency_records_run_idx" ON "idempotency_records" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "risk_findings_run_idx" ON "risk_findings" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "tool_invocations_run_idx" ON "tool_invocations" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "tool_invocations_tool_status_idx" ON "tool_invocations" USING btree ("tool_name","status");