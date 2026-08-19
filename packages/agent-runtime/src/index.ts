import { randomUUID } from "node:crypto";
import type { AgentEventStore } from "@ear/agent-protocol";
import type {
  AgentIdentity,
  AgentRunStatus,
  EvidenceRecord,
  RiskFinding,
} from "@ear/domain";
import type { ToolRegistry } from "@ear/tool-registry";
import type { z } from "zod";

export interface AgentExecutionResult<TState = unknown> {
  status: AgentRunStatus;
  state: TState;
  evidence?: EvidenceRecord[];
  findings?: RiskFinding[];
}

export interface AgentExecutionContext {
  runId: string;
  identity: AgentIdentity;
  tools: ToolRegistry;
  events: AgentEventStore;
}

export interface AgentDefinition<TInput = unknown, TState = unknown> {
  id: string;
  name: string;
  version: string;
  approvalScopes?: string[];
  inputSchema: z.ZodType<TInput>;
  start(input: TInput, context: AgentExecutionContext): Promise<AgentExecutionResult<TState>>;
  approve?(
    state: TState,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<TState>>;
  recoverApproved?(
    state: TState,
    approvedBy: string,
    context: AgentExecutionContext,
  ): Promise<AgentExecutionResult<TState>>;
}

export interface AgentRunRecord<TState = unknown> {
  id: string;
  agentId: string;
  agentVersion: string;
  tenantId: string;
  userId: string;
  status: AgentRunStatus;
  input: unknown;
  state: TState;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunTransitionRecord {
  id: string;
  runId: string;
  tenantId: string;
  fromStatus: AgentRunStatus | null;
  toStatus: AgentRunStatus;
  actorId: string;
  reason: string;
  occurredAt: string;
}

export type NewAgentRunTransition = Omit<AgentRunTransitionRecord, "id" | "occurredAt">;

export interface ApprovedRecoveryCandidate {
  run: AgentRunRecord;
  identity: AgentIdentity;
}

export interface AgentRunStore {
  create(record: AgentRunRecord, transition: NewAgentRunTransition): Promise<void>;
  save(record: AgentRunRecord, transition: NewAgentRunTransition): Promise<void>;
  get(id: string): Promise<AgentRunRecord | undefined>;
  listTransitions(runId: string, tenantId: string): Promise<AgentRunTransitionRecord[]>;
  requestApproval(input: {
    runId: string;
    tenantId: string;
    payload: unknown;
  }): Promise<void>;
  claimApproval(input: {
    runId: string;
    tenantId: string;
    identity: AgentIdentity;
  }): Promise<boolean>;
  getApprovedIdentity(runId: string, tenantId: string): Promise<AgentIdentity | undefined>;
  listApprovedRecoverable(limit: number): Promise<ApprovedRecoveryCandidate[]>;
  saveArtifacts(input: {
    runId: string;
    tenantId: string;
    evidence: EvidenceRecord[];
    findings: RiskFinding[];
  }): Promise<void>;
}

export class AgentRegistry {
  private readonly definitions = new Map<string, AgentDefinition>();

  register(definition: AgentDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`Agent already registered: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
  }

  get(id: string): AgentDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown agent: ${id}`);
    return definition;
  }

  list(): Array<Pick<AgentDefinition, "id" | "name" | "version">> {
    return [...this.definitions.values()].map(({ id, name, version }) => ({
      id,
      name,
      version,
    }));
  }
}

export class InMemoryAgentRunStore implements AgentRunStore {
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly transitions = new Map<string, AgentRunTransitionRecord[]>();
  private readonly approvals = new Map<
    string,
    {
      tenantId: string;
      status: "pending" | "approved";
      payload: unknown;
      identity?: AgentIdentity;
    }
  >();

  async create(record: AgentRunRecord, transition: NewAgentRunTransition): Promise<void> {
    if (this.runs.has(record.id)) throw new Error(`Run already exists: ${record.id}`);
    this.runs.set(record.id, record);
    this.appendTransition(transition);
  }

  async save(record: AgentRunRecord, transition: NewAgentRunTransition): Promise<void> {
    if (!this.runs.has(record.id)) throw new Error(`Unknown run: ${record.id}`);
    this.runs.set(record.id, record);
    this.appendTransition(transition);
  }

  async get(id: string): Promise<AgentRunRecord | undefined> {
    return this.runs.get(id);
  }

  async listTransitions(runId: string, tenantId: string): Promise<AgentRunTransitionRecord[]> {
    return (this.transitions.get(runId) ?? []).filter((item) => item.tenantId === tenantId);
  }

  async requestApproval(input: {
    runId: string;
    tenantId: string;
    payload: unknown;
  }): Promise<void> {
    if (!this.approvals.has(input.runId)) {
      this.approvals.set(input.runId, {
        tenantId: input.tenantId,
        status: "pending",
        payload: input.payload,
      });
    }
  }

  async claimApproval(input: {
    runId: string;
    tenantId: string;
    identity: AgentIdentity;
  }): Promise<boolean> {
    const approval = this.approvals.get(input.runId);
    if (!approval || approval.tenantId !== input.tenantId || approval.status !== "pending") {
      return false;
    }
    approval.status = "approved";
    approval.identity = input.identity;
    return true;
  }

  async getApprovedIdentity(runId: string, tenantId: string): Promise<AgentIdentity | undefined> {
    const approval = this.approvals.get(runId);
    if (!approval || approval.tenantId !== tenantId || approval.status !== "approved") {
      return undefined;
    }
    return approval.identity;
  }

  async listApprovedRecoverable(limit: number): Promise<ApprovedRecoveryCandidate[]> {
    const candidates: ApprovedRecoveryCandidate[] = [];
    for (const run of this.runs.values()) {
      const identity = await this.getApprovedIdentity(run.id, run.tenantId);
      if (run.status === "waiting_approval" && identity) candidates.push({ run, identity });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }

  async saveArtifacts(_input: {
    runId: string;
    tenantId: string;
    evidence: EvidenceRecord[];
    findings: RiskFinding[];
  }): Promise<void> {}

  private appendTransition(input: NewAgentRunTransition): void {
    const transitions = this.transitions.get(input.runId) ?? [];
    transitions.push({
      ...input,
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
    });
    this.transitions.set(input.runId, transitions);
  }
}

export class RunAccessDeniedError extends Error {}
export class InvalidRunStateError extends Error {}

export class AgentRuntime {
  constructor(
    private readonly agents: AgentRegistry,
    private readonly tools: ToolRegistry,
    private readonly events: AgentEventStore,
    private readonly runs: AgentRunStore = new InMemoryAgentRunStore(),
  ) {}

  listAgents() {
    return this.agents.list();
  }

  async start(agentId: string, rawInput: unknown, identity: AgentIdentity) {
    const definition = this.agents.get(agentId);
    const input = definition.inputSchema.parse(rawInput);
    const runId = randomUUID();
    const now = new Date().toISOString();
    const context: AgentExecutionContext = {
      runId,
      identity,
      tools: this.tools,
      events: this.events,
    };
    const initial: AgentRunRecord = {
      id: runId,
      agentId,
      agentVersion: definition.version,
      tenantId: identity.tenantId,
      userId: identity.userId,
      status: "running",
      input,
      state: {},
      createdAt: now,
      updatedAt: now,
    };
    await this.runs.create(initial, {
      runId,
      tenantId: identity.tenantId,
      fromStatus: null,
      toStatus: "running",
      actorId: identity.userId,
      reason: "run.created",
    });
    await this.events.append(runId, {
      type: "run.created",
      payload: { agentId, version: definition.version },
    });

    try {
      const result = await definition.start(input, context);
      const record: AgentRunRecord = {
        ...initial,
        status: result.status,
        state: result.state,
        updatedAt: new Date().toISOString(),
      };
      await this.runs.save(
        record,
        transitionFrom(
          initial,
          record,
          identity.userId,
          record.status === "waiting_approval" ? "execution.paused" : "execution.completed",
        ),
      );
      await this.runs.saveArtifacts({
        runId,
        tenantId: identity.tenantId,
        evidence: result.evidence ?? [],
        findings: result.findings ?? [],
      });
      if (record.status === "waiting_approval") {
        await this.runs.requestApproval({
          runId,
          tenantId: identity.tenantId,
          payload: { agentId, agentVersion: definition.version },
        });
      }
      return record;
    } catch (error) {
      const failed: AgentRunRecord = {
        ...initial,
        status: "failed",
        state: { error: error instanceof Error ? error.message : String(error) },
        updatedAt: new Date().toISOString(),
      };
      await this.runs.save(failed, transitionFrom(initial, failed, identity.userId, "execution.failed"));
      await this.events.append(runId, {
        type: "run.failed",
        payload: failed.state,
      });
      throw error;
    }
  }

  async getRun(runId: string, identity: AgentIdentity): Promise<AgentRunRecord> {
    const record = await this.runs.get(runId);
    if (!record) throw new Error(`Unknown run: ${runId}`);
    if (record.tenantId !== identity.tenantId) {
      throw new RunAccessDeniedError("Run belongs to another tenant.");
    }
    return record;
  }

  async getRunTransitions(runId: string, identity: AgentIdentity) {
    await this.getRun(runId, identity);
    return this.runs.listTransitions(runId, identity.tenantId);
  }

  async approve(runId: string, identity: AgentIdentity): Promise<AgentRunRecord> {
    const record = await this.getRun(runId, identity);
    if (record.status !== "waiting_approval") {
      throw new InvalidRunStateError(`Run is not waiting for approval: ${record.status}`);
    }
    const definition = this.agents.get(record.agentId);
    if (!definition.approve) {
      throw new InvalidRunStateError(`Agent does not support approval: ${record.agentId}`);
    }
    const missingScopes = (definition.approvalScopes ?? []).filter(
      (scope) => !identity.scopes?.includes(scope),
    );
    if (missingScopes.length > 0) {
      throw new RunAccessDeniedError(`Missing approval scopes: ${missingScopes.join(", ")}`);
    }
    const claimed = await this.runs.claimApproval({
      runId,
      tenantId: identity.tenantId,
      identity,
    });
    if (!claimed) {
      throw new InvalidRunStateError("Approval has already been decided.");
    }
    const result = await definition.approve(record.state, {
      runId,
      identity,
      tools: this.tools,
      events: this.events,
    });
    const updated: AgentRunRecord = {
      ...record,
      status: result.status,
      state: result.state,
      updatedAt: new Date().toISOString(),
    };
    await this.runs.save(
      updated,
      transitionFrom(record, updated, identity.userId, "approval.resumed"),
    );
    await this.runs.saveArtifacts({
      runId,
      tenantId: identity.tenantId,
      evidence: result.evidence ?? [],
      findings: result.findings ?? [],
    });
    return updated;
  }

  async recoverApproved(runId: string, identity: AgentIdentity): Promise<AgentRunRecord> {
    const record = await this.getRun(runId, identity);
    if (["completed", "failed", "cancelled"].includes(record.status)) return record;
    const definition = this.agents.get(record.agentId);
    if (!definition.recoverApproved) {
      throw new InvalidRunStateError(`Agent does not support recovery: ${record.agentId}`);
    }
    const approvedIdentity = await this.runs.getApprovedIdentity(runId, identity.tenantId);
    if (!approvedIdentity) {
      throw new InvalidRunStateError("Run has no approved decision to recover.");
    }
    const result = await definition.recoverApproved(record.state, approvedIdentity.userId, {
      runId,
      identity: approvedIdentity,
      tools: this.tools,
      events: this.events,
    });
    const updated: AgentRunRecord = {
      ...record,
      status: result.status,
      state: result.state,
      updatedAt: new Date().toISOString(),
    };
    await this.runs.save(
      updated,
      transitionFrom(record, updated, approvedIdentity.userId, "recovery.reconciled"),
    );
    await this.runs.saveArtifacts({
      runId,
      tenantId: identity.tenantId,
      evidence: result.evidence ?? [],
      findings: result.findings ?? [],
    });
    return updated;
  }

  async recoverApprovedRuns(limit = 100): Promise<{
    scanned: number;
    recovered: string[];
    failed: Array<{ runId: string; error: string }>;
  }> {
    const candidates = await this.runs.listApprovedRecoverable(limit);
    const settled = await Promise.allSettled(
      candidates.map(({ run, identity }) => this.recoverApproved(run.id, identity)),
    );
    const recovered: string[] = [];
    const failed: Array<{ runId: string; error: string }> = [];
    settled.forEach((result, index) => {
      const runId = candidates[index]!.run.id;
      if (result.status === "fulfilled") recovered.push(runId);
      else {
        failed.push({
          runId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
    return { scanned: candidates.length, recovered, failed };
  }
}

function transitionFrom(
  previous: AgentRunRecord,
  next: AgentRunRecord,
  actorId: string,
  reason: string,
): NewAgentRunTransition {
  return {
    runId: next.id,
    tenantId: next.tenantId,
    fromStatus: previous.status,
    toStatus: next.status,
    actorId,
    reason,
  };
}
