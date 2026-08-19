import { AgentRegistry, AgentRuntime, RunAccessDeniedError } from "@ear/agent-runtime";
import { InMemoryAgentEventStore } from "@ear/agent-protocol";
import { createRiskAgentDefinition, registerMockPaasTools, type RiskAgentState } from "@ear/risk-agent";
import { RuleBasedObjectPermissionPolicy, ToolRegistry } from "@ear/tool-registry";
import { beforeEach, describe, expect, it } from "vitest";

describe("项目风控 Agent", () => {
  let runtime: AgentRuntime;
  let events: InMemoryAgentEventStore;

  beforeEach(() => {
    events = new InMemoryAgentEventStore();
    const tools = new ToolRegistry(
      undefined,
      undefined,
      new RuleBasedObjectPermissionPolicy([
        { appName: "*", metaName: "*", action: "*" },
      ]),
    );
    registerMockPaasTools(tools);
    const agents = new AgentRegistry();
    agents.register(createRiskAgentDefinition());
    runtime = new AgentRuntime(agents, tools, events);
  });

  it("应完成多源取证并在写回前等待人工确认", async () => {
    const run = await runtime.start(
      "risk-agent",
      { caseId: "case-1", projectCode: "P-1", supplierCode: "S-1" },
      { tenantId: "tenant-a", userId: "reviewer-1" },
    );
    const state = run.state as RiskAgentState;

    expect(run.status).toBe("waiting_approval");
    expect(state.coverage).toBe(1);
    expect(state.evidence).toHaveLength(5);
    expect(state.findings).toHaveLength(2);
    const evidenceIds = new Set(state.evidence.map((item) => item.id));
    expect(state.findings.every((finding) => finding.evidenceIds.every((id) => evidenceIds.has(id)))).toBe(true);
    expect((await events.replay(run.id)).some((event) => event.type === "approval.required")).toBe(true);
  });

  it("应在人工确认后执行一次幂等写回并完成运行", async () => {
    const identity = {
      tenantId: "tenant-a",
      userId: "reviewer-1",
      scopes: ["risk:approve", "risk:write"],
    };
    const run = await runtime.start(
      "risk-agent",
      { caseId: "case-1", projectCode: "P-1", supplierCode: "S-1" },
      identity,
    );
    const completed = await runtime.approve(run.id, identity);
    const state = completed.state as RiskAgentState;

    expect(completed.status).toBe("completed");
    expect(state.writeBack).toEqual({ taskId: "rectification-case-1", created: true });
    expect((await events.replay(run.id)).at(-1)?.type).toBe("run.completed");
  });

  it("应阻止其他租户读取运行状态", async () => {
    const run = await runtime.start(
      "risk-agent",
      { caseId: "case-1", projectCode: "P-1", supplierCode: "S-1" },
      { tenantId: "tenant-a", userId: "reviewer-1" },
    );

    expect(() =>
      runtime.getRun(run.id, { tenantId: "tenant-b", userId: "reviewer-2" }),
    ).rejects.toThrow(RunAccessDeniedError);
  });
});
