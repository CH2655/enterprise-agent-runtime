import { randomUUID } from "node:crypto";
import type { EvidenceRecord, RiskFinding } from "@ear/domain";
import {
  type ApprovedRecoveryCandidate,
  type AgentRunRecord,
  type AgentRunTransitionRecord,
  type AgentRunStore,
  type NewAgentRunTransition,
  InvalidRunStateError,
  RunAccessDeniedError,
} from "@ear/agent-runtime";
import {
  createDatabaseConnection,
  evidenceRecords,
  PostgresToolIdempotencyStore,
  riskFindings,
  toolInvocations,
} from "@ear/persistence";
import { ToolRegistry } from "@ear/tool-registry";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../../apps/api/src/app.js";
import {
  createPostgresInfrastructure,
  type RuntimeInfrastructure,
} from "../../../apps/api/src/infrastructure.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;
const identity = {
  tenantId: "tenant-a",
  userId: "reviewer-1",
  scopes: ["risk:approve", "risk:write"],
};

describeWithDatabase("PostgreSQL Runtime集成", () => {
  const resources: Array<{
    app: ReturnType<typeof createApp>["app"];
    infrastructure: RuntimeInfrastructure;
  }> = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map(({ app }) => app.close()));
  });

  it("应在重建Runtime后从PostgreSQL checkpoint恢复审批", async () => {
    const first = await buildPersistentApp();
    const run = await first.runtime.start(
      "risk-agent",
      { caseId: randomUUID(), projectCode: "P-1", supplierCode: "S-1" },
      identity,
    );
    const beforeRestart = await first.events.replay(run.id);
    const verificationConnection = createDatabaseConnection(databaseUrl!);
    const persistedEvidence = await verificationConnection.db
      .select()
      .from(evidenceRecords)
      .where(eq(evidenceRecords.runId, run.id));
    const persistedFindings = await verificationConnection.db
      .select()
      .from(riskFindings)
      .where(eq(riskFindings.runId, run.id));
    await verificationConnection.close();
    expect(run.status).toBe("waiting_approval");
    expect(beforeRestart.at(-1)?.type).toBe("approval.required");
    expect(persistedEvidence).toHaveLength(5);
    expect(persistedFindings).toHaveLength(2);

    await first.app.close();
    resources.splice(resources.findIndex(({ app }) => app === first.app), 1);

    const second = await buildPersistentApp();
    const restored = await second.runtime.getRun(run.id, identity);
    await expect(
      second.runtime.getRun(run.id, { tenantId: "tenant-b", userId: "reviewer-2" }),
    ).rejects.toBeInstanceOf(RunAccessDeniedError);
    const completed = await second.runtime.approve(run.id, identity);
    const afterRestart = await second.events.replay(run.id);
    const transitions = await second.runtime.getRunTransitions(run.id, identity);

    expect(restored.status).toBe("waiting_approval");
    expect(completed.status).toBe("completed");
    expect(afterRestart.at(-1)?.type).toBe("run.completed");
    expect(afterRestart.map((event) => event.sequence)).toEqual(
      afterRestart.map((_event, index) => index + 1),
    );
    expect(transitions.map(({ fromStatus, toStatus, reason }) => ({
      fromStatus,
      toStatus,
      reason,
    }))).toEqual([
      { fromStatus: null, toStatus: "running", reason: "run.created" },
      {
        fromStatus: "running",
        toStatus: "waiting_approval",
        reason: "execution.paused",
      },
      {
        fromStatus: "waiting_approval",
        toStatus: "completed",
        reason: "approval.resumed",
      },
    ]);
  });

  it("应在并发审批时只允许一次业务写回", async () => {
    const persistent = await buildPersistentApp();
    const run = await persistent.runtime.start(
      "risk-agent",
      { caseId: randomUUID(), projectCode: "P-1", supplierCode: "S-1" },
      identity,
    );

    const results = await Promise.allSettled([
      persistent.runtime.approve(run.id, identity),
      persistent.runtime.approve(run.id, identity),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    const connection = createDatabaseConnection(databaseUrl!);
    const writes = await connection.db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.runId, run.id));
    await connection.close();

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidRunStateError);
    expect(
      writes.filter(
        (item) => item.toolName === "create_rectification_task" && item.status === "completed",
      ),
    ).toHaveLength(1);
  });

  it("应为并发追加的事件分配唯一连续序号", async () => {
    const persistent = await buildPersistentApp();
    const run = await persistent.runtime.start(
      "risk-agent",
      { caseId: randomUUID(), projectCode: "P-1", supplierCode: "S-1" },
      identity,
    );
    const before = await persistent.events.replay(run.id);

    await Promise.all(
      Array.from({ length: 10 }, (_item, index) =>
        persistent.events.append(run.id, {
          type: "node.progress",
          nodeId: "integration-test",
          payload: { index },
        }),
      ),
    );
    const replayed = await persistent.events.replay(run.id);
    const added = replayed.slice(before.length);

    expect(added.map((event) => event.sequence)).toEqual(
      Array.from({ length: 10 }, (_item, index) => before.length + index + 1),
    );
  });

  it("应在重建Tool Registry后复用数据库中的幂等结果", async () => {
    const persistent = await buildPersistentApp();
    const caseId = randomUUID();
    const run = await persistent.runtime.start(
      "risk-agent",
      { caseId, projectCode: "P-1", supplierCode: "S-1" },
      identity,
    );
    await persistent.runtime.approve(run.id, identity);

    const connection = createDatabaseConnection(databaseUrl!);
    const execute = vi.fn(async () => ({ taskId: "duplicate-task", created: true }));
    const registry = new ToolRegistry(
      undefined,
      new PostgresToolIdempotencyStore(connection.db),
    );
    registry.register({
      name: "create_rectification_task",
      description: "测试持久化幂等结果",
      access: "write",
      inputSchema: z.object({ caseId: z.string(), findingIds: z.array(z.string()) }),
      outputSchema: z.object({ taskId: z.string(), created: z.boolean() }),
      execute,
    });

    const result = await registry.execute(
      "create_rectification_task",
      { caseId, findingIds: ["finding-enterprise-credit"] },
      { runId: run.id, identity },
      {
        approval: { approved: true, approvedBy: identity.userId },
        idempotencyKey: `${run.id}:rectification`,
      },
    );
    await connection.close();

    expect(result).toEqual({ taskId: `rectification-${caseId}`, created: true });
    expect(execute).not.toHaveBeenCalled();
  });

  it("应在写回成功但Run保存失败后从最终checkpoint校准状态", async () => {
    const base = await createPostgresInfrastructure(databaseUrl!);
    const failingInfrastructure: RuntimeInfrastructure = {
      ...base,
      runs: new FailOnceOnCompletedRunStore(base.runs),
    };
    const first = createApp({ infrastructure: failingInfrastructure });
    resources.push({ app: first.app, infrastructure: failingInfrastructure });
    await first.app.ready();
    const caseId = randomUUID();
    const run = await first.runtime.start(
      "risk-agent",
      { caseId, projectCode: "P-1", supplierCode: "S-1" },
      identity,
    );

    await expect(first.runtime.approve(run.id, identity)).rejects.toThrow(
      "Injected completed save failure",
    );
    expect((await first.runtime.getRun(run.id, identity)).status).toBe("waiting_approval");
    await first.app.close();
    resources.splice(resources.findIndex(({ app }) => app === first.app), 1);

    const second = await buildPersistentApp();
    const recovered = await second.runtime.getRun(run.id, identity);
    const transitions = await second.runtime.getRunTransitions(run.id, identity);
    const connection = createDatabaseConnection(databaseUrl!);
    const writes = await connection.db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.runId, run.id));
    await connection.close();

    expect(recovered.status).toBe("completed");
    expect(transitions.at(-1)).toMatchObject({
      fromStatus: "waiting_approval",
      toStatus: "completed",
      actorId: identity.userId,
      reason: "recovery.reconciled",
    });
    expect(
      writes.filter(
        (item) => item.toolName === "create_rectification_task" && item.status === "completed",
      ),
    ).toHaveLength(1);
  });

  async function buildPersistentApp() {
    const infrastructure = await createPostgresInfrastructure(databaseUrl!);
    const result = createApp({ infrastructure });
    resources.push({ app: result.app, infrastructure });
    await result.app.ready();
    return result;
  }
});

class FailOnceOnCompletedRunStore implements AgentRunStore {
  private failed = false;

  constructor(private readonly delegate: AgentRunStore) {}

  create(record: AgentRunRecord, transition: NewAgentRunTransition): Promise<void> {
    return this.delegate.create(record, transition);
  }

  async save(record: AgentRunRecord, transition: NewAgentRunTransition): Promise<void> {
    if (record.status === "completed" && !this.failed) {
      this.failed = true;
      throw new Error("Injected completed save failure");
    }
    await this.delegate.save(record, transition);
  }

  get(id: string): Promise<AgentRunRecord | undefined> {
    return this.delegate.get(id);
  }

  listTransitions(runId: string, tenantId: string): Promise<AgentRunTransitionRecord[]> {
    return this.delegate.listTransitions(runId, tenantId);
  }

  requestApproval(input: {
    runId: string;
    tenantId: string;
    payload: unknown;
  }): Promise<void> {
    return this.delegate.requestApproval(input);
  }

  claimApproval(input: {
    runId: string;
    tenantId: string;
    identity: typeof identity;
  }): Promise<boolean> {
    return this.delegate.claimApproval(input);
  }

  getApprovedIdentity(runId: string, tenantId: string) {
    return this.delegate.getApprovedIdentity(runId, tenantId);
  }

  listApprovedRecoverable(limit: number): Promise<ApprovedRecoveryCandidate[]> {
    return this.delegate.listApprovedRecoverable(limit);
  }

  saveArtifacts(input: {
    runId: string;
    tenantId: string;
    evidence: EvidenceRecord[];
    findings: RiskFinding[];
  }): Promise<void> {
    return this.delegate.saveArtifacts(input);
  }
}
