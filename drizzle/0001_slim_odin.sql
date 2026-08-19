CREATE TABLE "agent_run_transitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"from_status" "agent_run_status",
	"to_status" "agent_run_status" NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_run_transitions" ADD CONSTRAINT "agent_run_transitions_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_run_transitions_run_idx" ON "agent_run_transitions" USING btree ("tenant_id","run_id","occurred_at");