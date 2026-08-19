CREATE TYPE "public"."knowledge_document_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."knowledge_outbox_status" AS ENUM('pending', 'processing', 'failed', 'completed');--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"document_id" uuid NOT NULL,
	"tenant_id" text NOT NULL,
	"document_key" text NOT NULL,
	"document_version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"section" text NOT NULL,
	"start_line" integer NOT NULL,
	"end_line" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"permission_tags" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"document_key" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" "knowledge_document_status" DEFAULT 'active' NOT NULL,
	"permission_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"indexed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"document_id" uuid NOT NULL,
	"event_type" text DEFAULT 'knowledge.document.index' NOT NULL,
	"status" "knowledge_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_outbox" ADD CONSTRAINT "knowledge_outbox_document_id_knowledge_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."knowledge_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_chunks_document_ordinal_unique" ON "knowledge_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_tenant_document_idx" ON "knowledge_chunks" USING btree ("tenant_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_documents_tenant_key_version_unique" ON "knowledge_documents" USING btree ("tenant_id","document_key","version");--> statement-breakpoint
CREATE INDEX "knowledge_documents_tenant_key_status_idx" ON "knowledge_documents" USING btree ("tenant_id","document_key","status");--> statement-breakpoint
CREATE INDEX "knowledge_outbox_status_available_idx" ON "knowledge_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "knowledge_outbox_tenant_document_idx" ON "knowledge_outbox" USING btree ("tenant_id","document_id");