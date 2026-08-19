import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const agentRunStatus = pgEnum("agent_run_status", [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);

export const invocationStatus = pgEnum("invocation_status", [
  "started",
  "completed",
  "failed",
]);

export const idempotencyStatus = pgEnum("idempotency_status", [
  "started",
  "completed",
  "failed",
]);

export const knowledgeDocumentStatus = pgEnum("knowledge_document_status", [
  "active",
  "archived",
]);

export const knowledgeOutboxStatus = pgEnum("knowledge_outbox_status", [
  "pending",
  "processing",
  "failed",
  "completed",
]);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    agentVersion: text("agent_version").notNull(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    status: agentRunStatus("status").notNull(),
    input: jsonb("input").notNull(),
    state: jsonb("state").notNull(),
    eventSequence: integer("event_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("agent_runs_tenant_status_idx").on(table.tenantId, table.status),
    index("agent_runs_tenant_created_idx").on(table.tenantId, table.createdAt),
  ],
);

export const agentEvents = pgTable(
  "agent_events",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    nodeId: text("node_id"),
    payload: jsonb("payload").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.sequence] }),
    index("agent_events_run_timestamp_idx").on(table.runId, table.timestamp),
  ],
);

export const agentRunTransitions = pgTable(
  "agent_run_transitions",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    fromStatus: agentRunStatus("from_status"),
    toStatus: agentRunStatus("to_status").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("agent_run_transitions_run_idx").on(table.tenantId, table.runId, table.occurredAt),
  ],
);

export const approvalTasks = pgTable(
  "approval_tasks",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    payload: jsonb("payload").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true, mode: "string" }),
    decidedBy: text("decided_by"),
    decision: jsonb("decision"),
  },
  (table) => [
    uniqueIndex("approval_tasks_run_unique").on(table.runId),
    index("approval_tasks_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const evidenceRecords = pgTable(
  "evidence_records",
  {
    id: text("id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    category: text("category").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    content: text("content").notNull(),
    locator: text("locator"),
    hash: text("hash"),
    collectedAt: timestamp("collected_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.runId, table.id] }),
    index("evidence_records_run_idx").on(table.tenantId, table.runId),
  ],
);

export const riskFindings = pgTable(
  "risk_findings",
  {
    id: text("id").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    dimension: text("dimension").notNull(),
    level: text("level").notNull(),
    claim: text("claim").notNull(),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull(),
    confidence: integer("confidence_basis_points").notNull(),
    recommendation: text("recommendation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.runId, table.id] }),
    index("risk_findings_run_idx").on(table.tenantId, table.runId),
  ],
);

export const toolInvocations = pgTable(
  "tool_invocations",
  {
    id: uuid("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    toolName: text("tool_name").notNull(),
    access: text("access").notNull(),
    status: invocationStatus("status").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    error: text("error"),
    durationMs: integer("duration_ms"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("tool_invocations_run_idx").on(table.tenantId, table.runId),
    index("tool_invocations_tool_status_idx").on(table.toolName, table.status),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    tenantId: text("tenant_id").notNull(),
    toolName: text("tool_name").notNull(),
    key: text("key").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    status: idempotencyStatus("status").notNull().default("started"),
    result: jsonb("result"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.toolName, table.key] }),
    index("idempotency_records_run_idx").on(table.tenantId, table.runId),
  ],
);

export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    documentKey: text("document_key").notNull(),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    contentHash: text("content_hash").notNull(),
    status: knowledgeDocumentStatus("status").notNull().default("active"),
    permissionTags: jsonb("permission_tags").$type<string[]>().notNull().default([]),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    indexedAt: timestamp("indexed_at", { withTimezone: true, mode: "string" }),
  },
  (table) => [
    uniqueIndex("knowledge_documents_tenant_key_version_unique").on(
      table.tenantId,
      table.documentKey,
      table.version,
    ),
    uniqueIndex("knowledge_documents_tenant_key_active_unique")
      .on(table.tenantId, table.documentKey)
      .where(sql`${table.status} = 'active'`),
    index("knowledge_documents_tenant_key_status_idx").on(
      table.tenantId,
      table.documentKey,
      table.status,
    ),
  ],
);

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: uuid("id").primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull(),
    documentKey: text("document_key").notNull(),
    documentVersion: integer("document_version").notNull(),
    ordinal: integer("ordinal").notNull(),
    section: text("section").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    permissionTags: jsonb("permission_tags").$type<string[]>().notNull().default([]),
  },
  (table) => [
    uniqueIndex("knowledge_chunks_document_ordinal_unique").on(
      table.documentId,
      table.ordinal,
    ),
    index("knowledge_chunks_tenant_document_idx").on(table.tenantId, table.documentId),
  ],
);

export const knowledgeOutbox = pgTable(
  "knowledge_outbox",
  {
    id: uuid("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull().default("knowledge.document.index"),
    status: knowledgeOutboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    availableAt: timestamp("available_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("knowledge_outbox_status_available_idx").on(table.status, table.availableAt),
    index("knowledge_outbox_tenant_document_idx").on(table.tenantId, table.documentId),
  ],
);

export const runtimeSchema = {
  agentRuns,
  agentEvents,
  agentRunTransitions,
  approvalTasks,
  evidenceRecords,
  riskFindings,
  toolInvocations,
  idempotencyRecords,
  knowledgeDocuments,
  knowledgeChunks,
  knowledgeOutbox,
};

export const touchUpdatedAt = sql`now()`;
