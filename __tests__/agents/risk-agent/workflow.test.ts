import { AgentRegistry, AgentRuntime, RunAccessDeniedError } from "@ear/agent-runtime";
import { InMemoryAgentEventStore } from "@ear/agent-protocol";
import { createRiskAgentDefinition, registerMockPaasTools, type RiskAgentState } from "@ear/risk-agent";
import { ScriptedModelProvider } from "@ear/model-provider";
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

  it("应根据缺失证据生成第二轮补充计划且不重复成功工具", async () => {
    const model = new ScriptedModelProvider({
      "risk.plan": ({ callIndex }) => ({
        rationale: callIndex === 0 ? "先完成基础尽调" : "补齐资金证据",
        tools: callIndex === 0
          ? [
              "get_project_profile",
              "get_supplier_profile",
              "get_enterprise_risks",
              "search_internal_policy",
            ]
          : ["get_bank_statement_summary"],
      }),
      "risk.synthesize": () => ({
        findings: [
          {
            id: "finding-loop",
            dimension: "资金稳定性",
            level: "medium",
            claim: "补充取证后仍需人工复核资金风险。",
            evidenceIds: ["evidence-bank-statement", "evidence-policy"],
            confidence: 0.8,
            recommendation: "核验异常流水。",
          },
        ],
      }),
    });
    const events = new InMemoryAgentEventStore();
    const tools = new ToolRegistry(
      undefined,
      undefined,
      new RuleBasedObjectPermissionPolicy([
        { appName: "*", metaName: "*", action: "*" },
      ]),
    );
    registerMockPaasTools(tools);
    const agents = new AgentRegistry();
    agents.register(createRiskAgentDefinition(undefined, model));
    const dynamicRuntime = new AgentRuntime(agents, tools, events);

    const run = await dynamicRuntime.start(
      "risk-agent",
      { caseId: "case-loop", projectCode: "P-1", supplierCode: "S-1" },
      { tenantId: "tenant-a", userId: "reviewer-1" },
    );
    const state = run.state as RiskAgentState;
    const createdPlans = (await events.replay(run.id)).filter(
      (event) => event.type === "plan.created",
    );

    expect(run.status).toBe("waiting_approval");
    expect(state.iteration).toBe(2);
    expect(state.missingCategories).toEqual([]);
    expect(createdPlans).toHaveLength(2);
    expect(createdPlans[1]?.payload).toMatchObject({
      tools: ["get_bank_statement_summary"],
    });
  });

  it("应拒绝未知或写工具计划并进入人工补充", async () => {
    const model = new ScriptedModelProvider({
      "risk.plan": () => ({
        rationale: "尝试越过控制面",
        tools: ["create_rectification_task", "unknown_tool"],
      }),
    });
    const agents = new AgentRegistry();
    agents.register(createRiskAgentDefinition(undefined, model));
    const events = new InMemoryAgentEventStore();
    const guardedRuntime = new AgentRuntime(agents, new ToolRegistry(), events);

    const run = await guardedRuntime.start(
      "risk-agent",
      { caseId: "case-invalid-plan", projectCode: "P-1", supplierCode: "S-1" },
      { tenantId: "tenant-a", userId: "reviewer-1" },
    );

    expect(run.status).toBe("waiting_input");
    expect(
      (await events.replay(run.id)).some((event) => event.type === "plan.rejected"),
    ).toBe(true);
  });

  it("应在工具持续失败时最多执行三轮并进入人工补充", async () => {
    const toolByCategory: Record<string, string> = {
      project: "get_project_profile",
      supplier: "get_supplier_profile",
      "enterprise-risk": "get_enterprise_risks",
      "bank-statement": "get_bank_statement_summary",
      policy: "search_internal_policy",
    };
    const model = new ScriptedModelProvider({
      "risk.plan": ({ input }) => ({
        rationale: "只补取仍缺失的证据",
        tools: (input as { missingCategories: string[] }).missingCategories.map(
          (category) => toolByCategory[category],
        ),
      }),
    });
    const tools = new ToolRegistry(
      undefined,
      undefined,
      new RuleBasedObjectPermissionPolicy([
        { appName: "std", metaName: "project", action: "view" },
        { appName: "std", metaName: "supplier", action: "view" },
        { appName: "knowledge", metaName: "supplier_policy", action: "view" },
      ]),
    );
    registerMockPaasTools(tools);
    const agents = new AgentRegistry();
    agents.register(createRiskAgentDefinition(undefined, model));
    const boundedRuntime = new AgentRuntime(agents, tools, new InMemoryAgentEventStore());

    const run = await boundedRuntime.start(
      "risk-agent",
      { caseId: "case-bounded", projectCode: "P-1", supplierCode: "S-1" },
      { tenantId: "tenant-a", userId: "reviewer-1" },
    );
    const state = run.state as RiskAgentState;

    expect(run.status).toBe("waiting_input");
    expect(state.iteration).toBe(3);
    expect(state.missingCategories).toEqual(["bank-statement"]);
    expect(state.toolFailures).toHaveProperty("get_bank_statement_summary");
  });
});
