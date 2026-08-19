import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentEventListener,
  AgentEventStore,
  AgentEventType,
  NewAgentEvent,
} from "@ear/agent-protocol";
import type {
  AgentRunRecord,
  AgentRunStore,
  AgentRunTransitionRecord,
  ApprovedRecoveryCandidate,
  NewAgentRunTransition,
} from "@ear/agent-runtime";
import { AgentIdentitySchema, type EvidenceRecord, type RiskFinding } from "@ear/domain";
import type {
  IdempotencyBeginResult,
  ToolAuditRecord,
  ToolAuditSink,
  ToolIdempotencyStore,
} from "@ear/tool-registry";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { AgentDatabase } from "./index.js";
import {
  agentEvents,
  agentRunTransitions,
  agentRuns,
  approvalTasks,
  evidenceRecords,
  idempotencyRecords,
  riskFindings,
  toolInvocations,
} from "./schema.js";

export class PostgresAgentRunStore implements AgentRunStore {
  constructor(private readonly db: AgentDatabase) {}

  async create(record: AgentRunRecord, transition: NewAgentRunTransition): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(agentRuns).values(toRunRow(record));
      await tx.insert(agentRunTransitions).values(toTransitionRow(transition));
    });
  }

  async save(record: AgentRunRecord, transition: NewAgentRunTransition): Promise<void> {
    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(agentRuns)
        .set({
          status: record.status,
          input: record.input,
          state: record.state,
          updatedAt: record.updatedAt,
        })
        .where(
          and(
            eq(agentRuns.id, record.id),
            eq(agentRuns.tenantId, record.tenantId),
            eq(agentRuns.status, transition.fromStatus!),
          ),
        )
        .returning({ id: agentRuns.id });
      if (updated.length !== 1) {
        throw new Error(`Run state changed concurrently: ${record.id}`);
      }
      await tx.insert(agentRunTransitions).values(toTransitionRow(transition));
    });
  }

  async get(id: string): Promise<AgentRunRecord | undefined> {
    const [row] = await this.db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1);
    return row ? fromRunRow(row) : undefined;
  }

  async listTransitions(
    runId: string,
    tenantId: string,
  ): Promise<AgentRunTransitionRecord[]> {
    const rows = await this.db
      .select()
      .from(agentRunTransitions)
      .where(
        and(
          eq(agentRunTransitions.runId, runId),
          eq(agentRunTransitions.tenantId, tenantId),
        ),
      )
      .orderBy(asc(agentRunTransitions.occurredAt));
    return rows;
  }

  async requestApproval(input: {
    runId: string;
    tenantId: string;
    payload: unknown;
  }): Promise<void> {
    await this.db
      .insert(approvalTasks)
      .values({
        id: randomUUID(),
        runId: input.runId,
        tenantId: input.tenantId,
        payload: input.payload,
      })
      .onConflictDoNothing({ target: approvalTasks.runId });
  }

  async claimApproval(input: {
    runId: string;
    tenantId: string;
    identity: typeof AgentIdentitySchema._output;
  }): Promise<boolean> {
    const claimed = await this.db
      .update(approvalTasks)
      .set({
        status: "approved",
        decidedAt: new Date().toISOString(),
        decidedBy: input.identity.userId,
        decision: { approved: true, identity: input.identity },
      })
      .where(
        and(
          eq(approvalTasks.runId, input.runId),
          eq(approvalTasks.tenantId, input.tenantId),
          eq(approvalTasks.status, "pending"),
        ),
      )
      .returning({ id: approvalTasks.id });
    return claimed.length === 1;
  }

  async getApprovedIdentity(
    runId: string,
    tenantId: string,
  ): Promise<typeof AgentIdentitySchema._output | undefined> {
    const [approval] = await this.db
      .select({ decision: approvalTasks.decision })
      .from(approvalTasks)
      .where(
        and(
          eq(approvalTasks.runId, runId),
          eq(approvalTasks.tenantId, tenantId),
          eq(approvalTasks.status, "approved"),
        ),
      )
      .limit(1);
    if (!approval) return undefined;
    const decision = approval.decision as { identity?: unknown } | null;
    const parsed = AgentIdentitySchema.safeParse(decision?.identity);
    return parsed.success ? parsed.data : undefined;
  }

  async listApprovedRecoverable(limit: number): Promise<ApprovedRecoveryCandidate[]> {
    const rows = await this.db
      .select({ run: agentRuns, decision: approvalTasks.decision })
      .from(agentRuns)
      .innerJoin(approvalTasks, eq(approvalTasks.runId, agentRuns.id))
      .where(
        and(
          eq(agentRuns.status, "waiting_approval"),
          eq(approvalTasks.status, "approved"),
        ),
      )
      .orderBy(asc(agentRuns.updatedAt))
      .limit(limit);
    return rows.flatMap(({ run, decision }) => {
      const parsed = AgentIdentitySchema.safeParse(
        (decision as { identity?: unknown } | null)?.identity,
      );
      return parsed.success ? [{ run: fromRunRow(run), identity: parsed.data }] : [];
    });
  }

  async saveArtifacts(input: {
    runId: string;
    tenantId: string;
    evidence: EvidenceRecord[];
    findings: RiskFinding[];
  }): Promise<void> {
    await this.db.transaction(async (tx) => {
      const runWhere = and(
        eq(evidenceRecords.runId, input.runId),
        eq(evidenceRecords.tenantId, input.tenantId),
      );
      await tx.delete(evidenceRecords).where(runWhere);
      await tx
        .delete(riskFindings)
        .where(
          and(
            eq(riskFindings.runId, input.runId),
            eq(riskFindings.tenantId, input.tenantId),
          ),
        );
      if (input.evidence.length > 0) {
        await tx.insert(evidenceRecords).values(
          input.evidence.map((item) => ({
            id: item.id,
            runId: input.runId,
            tenantId: input.tenantId,
            category: item.category,
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            content: item.content,
            locator: item.locator,
            hash: item.hash,
            collectedAt: item.collectedAt,
          })),
        );
      }
      if (input.findings.length > 0) {
        await tx.insert(riskFindings).values(
          input.findings.map((item) => ({
            id: item.id,
            runId: input.runId,
            tenantId: input.tenantId,
            dimension: item.dimension,
            level: item.level,
            claim: item.claim,
            evidenceIds: item.evidenceIds,
            confidence: Math.round(item.confidence * 10_000),
            recommendation: item.recommendation,
          })),
        );
      }
    });
  }
}

export class PostgresAgentEventStore implements AgentEventStore {
  private readonly listenersByRun = new Map<string, Set<AgentEventListener>>();

  constructor(private readonly db: AgentDatabase) {}

  async append<TPayload>(
    runId: string,
    input: NewAgentEvent<TPayload>,
  ): Promise<AgentEvent<TPayload>> {
    const timestamp = new Date().toISOString();
    const sequence = await this.db.transaction(async (tx) => {
      const [run] = await tx
        .update(agentRuns)
        .set({ eventSequence: sql`${agentRuns.eventSequence} + 1` })
        .where(eq(agentRuns.id, runId))
        .returning({ sequence: agentRuns.eventSequence });
      if (!run) throw new Error(`Unknown run: ${runId}`);
      await tx.insert(agentEvents).values({
        runId,
        sequence: run.sequence,
        type: input.type,
        nodeId: input.nodeId,
        payload: input.payload,
        timestamp,
      });
      return run.sequence;
    });
    const event: AgentEvent<TPayload> = { ...input, runId, sequence, timestamp };
    for (const listener of this.listenersByRun.get(runId) ?? []) {
      listener(event as AgentEvent);
    }
    return event;
  }

  async replay(runId: string, afterSequence = 0): Promise<AgentEvent[]> {
    const rows = await this.db
      .select()
      .from(agentEvents)
      .where(and(eq(agentEvents.runId, runId), gt(agentEvents.sequence, afterSequence)))
      .orderBy(asc(agentEvents.sequence));
    return rows.map((row) => ({
      runId: row.runId,
      sequence: row.sequence,
      type: row.type as AgentEventType,
      ...(row.nodeId ? { nodeId: row.nodeId } : {}),
      timestamp: row.timestamp,
      payload: row.payload,
    }));
  }

  subscribe(runId: string, listener: AgentEventListener): () => void {
    const listeners = this.listenersByRun.get(runId) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    this.listenersByRun.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersByRun.delete(runId);
    };
  }
}

export class PostgresToolIdempotencyStore implements ToolIdempotencyStore {
  constructor(private readonly db: AgentDatabase) {}

  async begin(input: {
    tenantId: string;
    toolName: string;
    key: string;
    runId: string;
  }): Promise<IdempotencyBeginResult> {
    const inserted = await this.db
      .insert(idempotencyRecords)
      .values(input)
      .onConflictDoNothing()
      .returning({ key: idempotencyRecords.key });
    if (inserted.length === 1) return { status: "execute" };

    const [existing] = await this.db
      .select({
        status: idempotencyRecords.status,
        result: idempotencyRecords.result,
      })
      .from(idempotencyRecords)
      .where(idempotencyWhere(input))
      .limit(1);
    if (existing?.status === "completed") {
      return { status: "completed", result: existing.result };
    }
    if (existing?.status === "failed") {
      const retried = await this.db
        .update(idempotencyRecords)
        .set({
          status: "started",
          result: null,
          error: null,
          runId: input.runId,
          updatedAt: new Date().toISOString(),
        })
        .where(and(idempotencyWhere(input), eq(idempotencyRecords.status, "failed")))
        .returning({ key: idempotencyRecords.key });
      if (retried.length === 1) return { status: "execute" };
    }
    return { status: "in_progress" };
  }

  async complete(input: {
    tenantId: string;
    toolName: string;
    key: string;
    result: unknown;
  }): Promise<void> {
    await this.db
      .update(idempotencyRecords)
      .set({
        status: "completed",
        result: input.result,
        error: null,
        updatedAt: new Date().toISOString(),
      })
      .where(and(idempotencyWhere(input), eq(idempotencyRecords.status, "started")));
  }

  async fail(input: {
    tenantId: string;
    toolName: string;
    key: string;
    error: string;
  }): Promise<void> {
    await this.db
      .update(idempotencyRecords)
      .set({ status: "failed", error: input.error, updatedAt: new Date().toISOString() })
      .where(and(idempotencyWhere(input), eq(idempotencyRecords.status, "started")));
  }
}

export function createPostgresToolAuditSink(db: AgentDatabase): ToolAuditSink {
  return async (record: ToolAuditRecord) => {
    if (record.status === "started") {
      await db.insert(toolInvocations).values({
        id: record.invocationId,
        runId: record.runId,
        tenantId: record.tenantId,
        userId: record.userId,
        toolName: record.toolName,
        access: record.access,
        status: record.status,
      });
      return;
    }
    await db
      .update(toolInvocations)
      .set({
        status: record.status,
        durationMs: record.durationMs,
        error: record.error,
        completedAt: new Date().toISOString(),
      })
      .where(eq(toolInvocations.id, record.invocationId));
  };
}

function toRunRow(record: AgentRunRecord): typeof agentRuns.$inferInsert {
  return {
    id: record.id,
    agentId: record.agentId,
    agentVersion: record.agentVersion,
    tenantId: record.tenantId,
    userId: record.userId,
    status: record.status,
    input: record.input,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toTransitionRow(
  transition: NewAgentRunTransition,
): typeof agentRunTransitions.$inferInsert {
  return {
    id: randomUUID(),
    runId: transition.runId,
    tenantId: transition.tenantId,
    fromStatus: transition.fromStatus,
    toStatus: transition.toStatus,
    actorId: transition.actorId,
    reason: transition.reason,
  };
}

function fromRunRow(row: typeof agentRuns.$inferSelect): AgentRunRecord {
  return {
    id: row.id,
    agentId: row.agentId,
    agentVersion: row.agentVersion,
    tenantId: row.tenantId,
    userId: row.userId,
    status: row.status,
    input: row.input,
    state: row.state,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function idempotencyWhere(input: { tenantId: string; toolName: string; key: string }) {
  return and(
    eq(idempotencyRecords.tenantId, input.tenantId),
    eq(idempotencyRecords.toolName, input.toolName),
    eq(idempotencyRecords.key, input.key),
  );
}
