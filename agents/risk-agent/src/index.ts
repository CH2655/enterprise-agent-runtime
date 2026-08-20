import {
  Annotation,
  type BaseCheckpointSaver,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { AgentDefinition, AgentExecutionContext } from "@ear/agent-runtime";
import {
  type AgentRunStatus,
  type EvidenceRecord,
  type RiskCaseInput,
  RiskCaseInputSchema,
  type RiskFinding,
  RiskFindingSchema,
  type WriteBackResult,
} from "@ear/domain";
import {
  type ModelProvider,
  ScriptedModelProvider,
  type StructuredModelRequest,
} from "@ear/model-provider";
import type { ToolContext } from "@ear/tool-registry";
import { z } from "zod";

export { registerMockPaasTools } from "./mock-tools.js";

const REQUIRED_CATEGORIES = [
  "project",
  "supplier",
  "enterprise-risk",
  "bank-statement",
  "policy",
] as const;
const MAX_ITERATIONS = 3;

const RiskPlanSchema = z.object({
  rationale: z.string(),
  tools: z.array(z.string()),
});
type RiskPlan = z.infer<typeof RiskPlanSchema>;

const RiskSynthesisSchema = z.object({
  findings: z.array(RiskFindingSchema),
});

type RiskToolName = keyof typeof TOOL_SPECS;

interface RiskToolSpec {
  category: (typeof REQUIRED_CATEGORIES)[number];
  description: string;
  resultKey: string;
  input(state: RiskAgentState): unknown;
}

const TOOL_SPECS = {
  get_project_profile: {
    category: "project",
    description: "读取项目基本信息与预算",
    resultKey: "project",
    input: (state) => ({ code: state.request.projectCode }),
  },
  get_supplier_profile: {
    category: "supplier",
    description: "读取供应商工商档案",
    resultKey: "supplier",
    input: (state) => ({ code: state.request.supplierCode }),
  },
  get_enterprise_risks: {
    category: "enterprise-risk",
    description: "查询企业失信与司法风险",
    resultKey: "enterpriseRisk",
    input: (state) => ({ code: state.request.supplierCode }),
  },
  get_bank_statement_summary: {
    category: "bank-statement",
    description: "读取脱敏后的银行流水风险摘要",
    resultKey: "bankStatement",
    input: (state) => ({ code: state.request.supplierCode }),
  },
  search_internal_policy: {
    category: "policy",
    description: "检索当前租户的供应商准入制度",
    resultKey: "policy",
    input: () => ({ query: "供应商失信与资金异常准入规则" }),
  },
} satisfies Record<string, RiskToolSpec>;

export interface RiskAgentState {
  request: RiskCaseInput;
  status: AgentRunStatus;
  iteration: number;
  selectedTools: RiskToolName[];
  successfulTools: RiskToolName[];
  missingCategories: string[];
  planIssues: string[];
  evidence: EvidenceRecord[];
  findings: RiskFinding[];
  coverage: number;
  toolResults: Record<string, unknown>;
  toolFailures: Record<string, string>;
  verificationIssues: string[];
  writeBack?: WriteBackResult;
}

const RiskState = Annotation.Root({
  request: Annotation<RiskCaseInput>(),
  status: Annotation<AgentRunStatus>({ reducer: (_current, update) => update, default: () => "running" }),
  iteration: Annotation<number>({ reducer: (_current, update) => update, default: () => 0 }),
  selectedTools: Annotation<RiskToolName[]>({ reducer: (_current, update) => update, default: () => [] }),
  successfulTools: Annotation<RiskToolName[]>({ reducer: unionValues, default: () => [] }),
  missingCategories: Annotation<string[]>({
    reducer: (_current, update) => update,
    default: () => [...REQUIRED_CATEGORIES],
  }),
  planIssues: Annotation<string[]>({ reducer: (_current, update) => update, default: () => [] }),
  evidence: Annotation<EvidenceRecord[]>({
    reducer: (current, updates) => upsertEvidence(current, updates),
    default: () => [],
  }),
  findings: Annotation<RiskFinding[]>({ reducer: (_current, update) => update, default: () => [] }),
  coverage: Annotation<number>({ reducer: (_current, update) => update, default: () => 0 }),
  toolResults: Annotation<Record<string, unknown>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
  toolFailures: Annotation<Record<string, string>>({
    reducer: (_current, update) => update,
    default: () => ({}),
  }),
  verificationIssues: Annotation<string[]>({ reducer: (_current, update) => update, default: () => [] }),
  writeBack: Annotation<WriteBackResult | undefined>({ reducer: (_current, update) => update, default: () => undefined }),
});

interface ApprovalDecision {
  approved: boolean;
  approvedBy: string;
}

export function createRiskAgentDefinition(
  checkpointer: BaseCheckpointSaver = new MemorySaver(),
  modelProvider: ModelProvider = createDeterministicRiskModelProvider(),
): AgentDefinition<RiskCaseInput, RiskAgentState> {
  return {
    id: "risk-agent",
    name: "项目风控与供应商尽调 Agent",
    version: "0.2.0",
    approvalScopes: ["risk:approve", "risk:write"],
    inputSchema: RiskCaseInputSchema,
    async start(input, context) {
      const graph = createRiskGraph(context, checkpointer, modelProvider);
      const state = (await graph.invoke(
        {
          request: input,
          status: "running",
          iteration: 0,
          selectedTools: [],
          successfulTools: [],
          missingCategories: [...REQUIRED_CATEGORIES],
          planIssues: [],
          evidence: [],
          findings: [],
          coverage: 0,
          toolResults: {},
          toolFailures: {},
          verificationIssues: [],
        },
        { configurable: { thread_id: context.runId } },
      )) as RiskAgentState;
      return executionResult(state);
    },
    async approve(_state, context) {
      return executionResult(
        await resumeApprovedGraph(context, checkpointer, modelProvider, context.identity.userId),
      );
    },
    async recoverApproved(_state, approvedBy, context) {
      const graph = createRiskGraph(context, checkpointer, modelProvider);
      const snapshot = await graph.getState({ configurable: { thread_id: context.runId } });
      const persisted = snapshot.values as RiskAgentState;
      return executionResult(
        persisted.status === "completed"
          ? persisted
          : await resumeApprovedGraph(context, checkpointer, modelProvider, approvedBy),
      );
    },
  };
}

function executionResult(state: RiskAgentState) {
  return {
    status: state.status,
    state,
    evidence: state.evidence,
    findings: state.findings,
  };
}

async function resumeApprovedGraph(
  context: AgentExecutionContext,
  checkpointer: BaseCheckpointSaver,
  modelProvider: ModelProvider,
  approvedBy: string,
): Promise<RiskAgentState> {
  const graph = createRiskGraph(context, checkpointer, modelProvider);
  return (await graph.invoke(
    new Command({
      resume: { approved: true, approvedBy } satisfies ApprovalDecision,
    }),
    { configurable: { thread_id: context.runId } },
  )) as RiskAgentState;
}

function createRiskGraph(
  context: AgentExecutionContext,
  checkpointer: BaseCheckpointSaver,
  modelProvider: ModelProvider,
) {
  const graph = new StateGraph(RiskState)
    .addNode("plan", async (state: RiskAgentState) => {
      await emitNode(context, "plan", "正在生成本轮受约束取证计划");
      try {
        const plan = await generateWithRetry(modelProvider, {
          task: "risk.plan",
          system: [
            "你是企业供应商尽调规划器，只能选择只读工具。",
            "根据缺失证据选择最少必要工具，不得选择写工具或未知工具。",
          ].join("\n"),
          input: {
            request: state.request,
            iteration: state.iteration,
            missingCategories: state.missingCategories,
            successfulTools: state.successfulTools,
            previousFailures: state.toolFailures,
            toolCatalog: Object.entries(TOOL_SPECS).map(([name, spec]) => ({
              name,
              category: spec.category,
              description: spec.description,
            })),
          },
          schemaName: "risk_evidence_plan",
          schema: RiskPlanSchema,
        });
        const planIssues = validatePlan(plan, state);
        if (planIssues.length > 0) {
          await context.events.append(context.runId, {
            type: "plan.rejected",
            nodeId: "plan",
            payload: { tools: plan.tools, issues: planIssues },
          });
          return { status: "waiting_input" as const, selectedTools: [], planIssues };
        }
        await context.events.append(context.runId, {
          type: "plan.created",
          nodeId: "plan",
          payload: { iteration: state.iteration + 1, rationale: plan.rationale, tools: plan.tools },
        });
        return { selectedTools: plan.tools as RiskToolName[], planIssues: [] };
      } catch (error) {
        const issue = error instanceof Error ? error.message : String(error);
        await context.events.append(context.runId, {
          type: "plan.rejected",
          nodeId: "plan",
          payload: { issues: [issue] },
        });
        return { status: "waiting_input" as const, selectedTools: [], planIssues: [issue] };
      }
    })
    .addNode("collect", async (state: RiskAgentState) => {
      await emitNode(context, "collect", `正在执行第 ${state.iteration + 1} 轮取证`);
      const results = await Promise.all(
        state.selectedTools.map(async (toolName) => {
          const spec = TOOL_SPECS[toolName];
          try {
            const output = await context.tools.execute(
              toolName,
              spec.input(state),
              toolContext(context),
            );
            return { toolName, spec, output } as const;
          } catch (error) {
            return {
              toolName,
              spec,
              error: error instanceof Error ? error.message : String(error),
            } as const;
          }
        }),
      );
      const evidence: EvidenceRecord[] = [];
      const successfulTools: RiskToolName[] = [];
      const toolResults: Record<string, unknown> = {};
      const toolFailures: Record<string, string> = { ...state.toolFailures };
      for (const result of results) {
        if ("error" in result) {
          toolFailures[result.toolName] = result.error ?? "Unknown tool failure";
          continue;
        }
        successfulTools.push(result.toolName);
        delete toolFailures[result.toolName];
        toolResults[result.spec.resultKey] = result.output;
        const item = result.spec.category === "policy"
          ? policyEvidenceOf(context, result.output)
          : evidenceOf(
              context,
              result.spec.category,
              evidenceSourceType(result.spec.category),
              result.toolName,
              result.output,
            );
        evidence.push(item);
        await context.events.append(context.runId, {
          type: "evidence.added",
          nodeId: "collect",
          payload: { evidenceId: item.id, category: item.category },
        });
      }
      return {
        iteration: state.iteration + 1,
        evidence,
        successfulTools,
        toolResults,
        toolFailures,
      };
    })
    .addNode("evaluate", async (state: RiskAgentState) => {
      await emitNode(context, "evaluate", "正在检查审查维度的证据覆盖情况");
      const categories = new Set(state.evidence.map((item) => item.category));
      const missingCategories = REQUIRED_CATEGORIES.filter((category) => !categories.has(category));
      return {
        coverage: (REQUIRED_CATEGORIES.length - missingCategories.length) / REQUIRED_CATEGORIES.length,
        missingCategories,
      };
    })
    .addNode("waiting_input", async (state: RiskAgentState) => {
      await context.events.append(context.runId, {
        type: "run.waiting_input",
        nodeId: "waiting_input",
        payload: {
          iteration: state.iteration,
          missingCategories: state.missingCategories,
          issues: state.planIssues,
        },
      });
      return { status: "waiting_input" as const };
    })
    .addNode("synthesize", async (state: RiskAgentState) => {
      await emitNode(context, "synthesize", "正在基于证据生成结构化风险结论");
      try {
        const result = await generateWithRetry(modelProvider, {
          task: "risk.synthesize",
          system: [
            "你是企业供应商风险分析器，只能依据给定 Evidence 生成结论。",
            "每条 Finding 必须引用存在的 evidenceIds，不得虚构业务事实。",
            "dimension 只能使用“企业信用”或“资金稳定性”。",
            "企业信用结论必须同时引用 enterprise-risk 与 policy 证据；资金稳定性结论必须同时引用 bank-statement 与 policy 证据。",
            "没有对应风险事实时不要生成该维度 Finding。",
          ].join("\n"),
          input: { request: state.request, evidence: state.evidence, toolResults: state.toolResults },
          schemaName: "risk_findings",
          schema: RiskSynthesisSchema,
        });
        return { findings: result.findings };
      } catch (error) {
        const issue = error instanceof Error ? error.message : String(error);
        await context.events.append(context.runId, {
          type: "node.failed",
          nodeId: "synthesize",
          payload: { issues: [issue] },
        });
        return { status: "waiting_input" as const, verificationIssues: [issue] };
      }
    })
    .addNode("verify", async (state: RiskAgentState) => {
      await emitNode(context, "verify", "正在校验风险结论与证据引用关系");
      const evidenceIds = new Set(state.evidence.map((item) => item.id));
      const verificationIssues = state.findings.flatMap((finding) =>
        finding.evidenceIds
          .filter((id) => !evidenceIds.has(id))
          .map((id) => `${finding.id} references missing evidence ${id}`),
      );
      if (verificationIssues.length > 0) {
        await context.events.append(context.runId, {
          type: "node.failed",
          nodeId: "verify",
          payload: { verificationIssues },
        });
        return { status: "failed" as const, verificationIssues };
      }
      if (state.findings.length === 0) {
        await context.events.append(context.runId, {
          type: "run.completed",
          nodeId: "verify",
          payload: { findingCount: 0 },
        });
        return { status: "completed" as const, verificationIssues: [] };
      }
      await context.events.append(context.runId, {
        type: "approval.required",
        nodeId: "human_review",
        payload: { findingCount: state.findings.length },
      });
      return { status: "waiting_approval" as const, verificationIssues: [] };
    })
    .addNode("human_review", async (state: RiskAgentState) => {
      const decision = interrupt<
        { runId: string; findingCount: number; action: "create_rectification_task" },
        ApprovalDecision
      >({
        runId: context.runId,
        findingCount: state.findings.length,
        action: "create_rectification_task",
      });
      if (!decision.approved) return { status: "cancelled" as const };
      await context.events.append(context.runId, {
        type: "approval.completed",
        nodeId: "human_review",
        payload: { approvedBy: decision.approvedBy },
      });
      const writeBack = await context.tools.execute<WriteBackResult>(
        "create_rectification_task",
        {
          caseId: state.request.caseId,
          findingIds: state.findings.map((finding) => finding.id),
        },
        toolContext(context),
        {
          approval: { approved: true, approvedBy: decision.approvedBy },
          idempotencyKey: `${context.runId}:rectification`,
        },
      );
      await context.events.append(context.runId, {
        type: "run.completed",
        nodeId: "write_back",
        payload: writeBack,
      });
      return { status: "completed" as const, writeBack };
    })
    .addEdge(START, "plan")
    .addConditionalEdges(
      "plan",
      (state) => (state.status === "waiting_input" ? "waiting_input" : "collect"),
      { waiting_input: "waiting_input", collect: "collect" },
    )
    .addEdge("collect", "evaluate")
    .addConditionalEdges(
      "evaluate",
      (state) => {
        if (state.missingCategories.length === 0) return "synthesize";
        return state.iteration >= MAX_ITERATIONS ? "waiting_input" : "plan";
      },
      { plan: "plan", synthesize: "synthesize", waiting_input: "waiting_input" },
    )
    .addConditionalEdges(
      "synthesize",
      (state) => (state.status === "waiting_input" ? "end" : "verify"),
      { end: END, verify: "verify" },
    )
    .addConditionalEdges(
      "verify",
      (state) => (state.status === "waiting_approval" ? "human_review" : "end"),
      { end: END, human_review: "human_review" },
    )
    .addEdge("waiting_input", END)
    .addEdge("human_review", END);

  return graph.compile({ checkpointer });
}

function validatePlan(plan: RiskPlan, state: RiskAgentState): string[] {
  const issues: string[] = [];
  if (plan.tools.length === 0) issues.push("Plan must select at least one tool.");
  if (plan.tools.length > REQUIRED_CATEGORIES.length) issues.push("Plan exceeds tool budget.");
  if (new Set(plan.tools).size !== plan.tools.length) issues.push("Plan contains duplicate tools.");
  for (const toolName of plan.tools) {
    if (!(toolName in TOOL_SPECS)) {
      issues.push(`Tool is not in the read-only allowlist: ${toolName}`);
      continue;
    }
    const typedName = toolName as RiskToolName;
    if (state.successfulTools.includes(typedName)) {
      issues.push(`Plan repeats an already successful tool: ${toolName}`);
    }
    if (!state.missingCategories.includes(TOOL_SPECS[typedName].category)) {
      issues.push(`Tool does not address a missing category: ${toolName}`);
    }
  }
  return issues;
}

async function generateWithRetry<TOutput>(
  provider: ModelProvider,
  request: StructuredModelRequest<TOutput>,
): Promise<TOutput> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await provider.generateStructured(request);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function createDeterministicRiskModelProvider(): ModelProvider {
  return new ScriptedModelProvider({
    "risk.plan": ({ input }) => {
      const { missingCategories } = input as { missingCategories: string[] };
      return {
        rationale: "按缺失维度选择最小必要只读工具集合",
        tools: Object.entries(TOOL_SPECS)
          .filter(([, spec]) => missingCategories.includes(spec.category))
          .map(([name]) => name),
      };
    },
    "risk.synthesize": ({ input }) => {
      const { toolResults } = input as { toolResults: Record<string, unknown> };
      const enterpriseRisk = toolResults.enterpriseRisk as {
        dishonest: boolean;
        legalCaseCount: number;
      };
      const bank = toolResults.bankStatement as {
        abnormalTransactions: number;
        cashFlowStable: boolean;
      };
      const findings: RiskFinding[] = [];
      if (enterpriseRisk.dishonest) {
        findings.push({
          id: "finding-enterprise-credit",
          dimension: "企业信用",
          level: "high",
          claim: `供应商存在失信记录，并涉及 ${enterpriseRisk.legalCaseCount} 条法律案件。`,
          evidenceIds: ["evidence-enterprise-risk", "evidence-policy"],
          confidence: 0.96,
          recommendation: "进入人工复核，并要求补充信用修复或案件说明材料。",
        });
      }
      if (!bank.cashFlowStable) {
        findings.push({
          id: "finding-cash-flow",
          dimension: "资金稳定性",
          level: "medium",
          claim: `银行流水中发现 ${bank.abnormalTransactions} 笔异常交易，资金稳定性不足。`,
          evidenceIds: ["evidence-bank-statement", "evidence-policy"],
          confidence: 0.88,
          recommendation: "核验异常交易用途，并增加付款节点和履约保障措施。",
        });
      }
      return { findings };
    },
  });
}

function toolContext(context: AgentExecutionContext): ToolContext {
  return { identity: context.identity, runId: context.runId };
}

async function emitNode(
  context: AgentExecutionContext,
  nodeId: string,
  message: string,
): Promise<void> {
  await context.events.append(context.runId, {
    type: "node.started",
    nodeId,
    payload: { message },
  });
}

function evidenceOf(
  context: AgentExecutionContext,
  category: string,
  sourceType: EvidenceRecord["sourceType"],
  sourceId: string,
  value: unknown,
): EvidenceRecord {
  return {
    id: `evidence-${category}`,
    tenantId: context.identity.tenantId,
    runId: context.runId,
    category,
    sourceType,
    sourceId,
    content: JSON.stringify(value),
    collectedAt: new Date().toISOString(),
  };
}

function policyEvidenceOf(
  context: AgentExecutionContext,
  value: unknown,
): EvidenceRecord {
  const policy = value as {
    documentId: string;
    content: string;
    locator: string;
    contentHash?: string;
  };
  return {
    id: "evidence-policy",
    tenantId: context.identity.tenantId,
    runId: context.runId,
    category: "policy",
    sourceType: "knowledge",
    sourceId: policy.documentId,
    content: policy.content,
    locator: policy.locator,
    ...(policy.contentHash ? { hash: policy.contentHash } : {}),
    collectedAt: new Date().toISOString(),
  };
}

function evidenceSourceType(
  category: (typeof REQUIRED_CATEGORIES)[number],
): EvidenceRecord["sourceType"] {
  if (category === "policy") return "knowledge";
  if (category === "project" || category === "supplier") return "business_object";
  return "tool";
}

function upsertEvidence(current: EvidenceRecord[], updates: EvidenceRecord[]): EvidenceRecord[] {
  const records = new Map(current.map((item) => [item.id, item]));
  for (const item of updates) records.set(item.id, item);
  return [...records.values()];
}

function unionValues<T>(current: T[], updates: T[]): T[] {
  return [...new Set([...current, ...updates])];
}
