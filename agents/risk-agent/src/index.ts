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
import type {
  AgentRunStatus,
  EvidenceRecord,
  RiskCaseInput,
  RiskFinding,
  WriteBackResult,
} from "@ear/domain";
import { RiskCaseInputSchema } from "@ear/domain";
import type { ToolContext } from "@ear/tool-registry";

export { registerMockPaasTools } from "./mock-tools.js";

export interface RiskAgentState {
  request: RiskCaseInput;
  status: AgentRunStatus;
  iteration: number;
  evidence: EvidenceRecord[];
  findings: RiskFinding[];
  coverage: number;
  toolResults: Record<string, unknown>;
  verificationIssues: string[];
  writeBack?: WriteBackResult;
}

const RiskState = Annotation.Root({
  request: Annotation<RiskCaseInput>(),
  status: Annotation<AgentRunStatus>({ reducer: (_current, update) => update, default: () => "running" }),
  iteration: Annotation<number>({ reducer: (_current, update) => update, default: () => 0 }),
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
  verificationIssues: Annotation<string[]>({ reducer: (_current, update) => update, default: () => [] }),
  writeBack: Annotation<WriteBackResult | undefined>({ reducer: (_current, update) => update, default: () => undefined }),
});

interface ApprovalDecision {
  approved: boolean;
  approvedBy: string;
}

export function createRiskAgentDefinition(
  checkpointer: BaseCheckpointSaver = new MemorySaver(),
): AgentDefinition<RiskCaseInput, RiskAgentState> {
  return {
    id: "risk-agent",
    name: "项目风控与供应商尽调 Agent",
    version: "0.1.0",
    approvalScopes: ["risk:approve", "risk:write"],
    inputSchema: RiskCaseInputSchema,
    async start(input, context) {
      const graph = createRiskGraph(context, checkpointer);
      const state = (await graph.invoke(
        {
          request: input,
          status: "running",
          iteration: 0,
          evidence: [],
          findings: [],
          coverage: 0,
          toolResults: {},
          verificationIssues: [],
        },
        { configurable: { thread_id: context.runId } },
      )) as RiskAgentState;
      return {
        status: state.status,
        state,
        evidence: state.evidence,
        findings: state.findings,
      };
    },
    async approve(_state, context) {
      const resumed = await resumeApprovedGraph(context, checkpointer, context.identity.userId);
      return {
        status: resumed.status,
        state: resumed,
        evidence: resumed.evidence,
        findings: resumed.findings,
      };
    },
    async recoverApproved(_state, approvedBy, context) {
      const graph = createRiskGraph(context, checkpointer);
      const snapshot = await graph.getState({ configurable: { thread_id: context.runId } });
      const persisted = snapshot.values as RiskAgentState;
      const recovered = persisted.status === "completed"
        ? persisted
        : await resumeApprovedGraph(context, checkpointer, approvedBy);
      return {
        status: recovered.status,
        state: recovered,
        evidence: recovered.evidence,
        findings: recovered.findings,
      };
    },
  };
}

async function resumeApprovedGraph(
  context: AgentExecutionContext,
  checkpointer: BaseCheckpointSaver,
  approvedBy: string,
): Promise<RiskAgentState> {
  const graph = createRiskGraph(context, checkpointer);
  return (await graph.invoke(
    new Command({
      resume: { approved: true, approvedBy } satisfies ApprovalDecision,
    }),
    { configurable: { thread_id: context.runId } },
  )) as RiskAgentState;
}

function createRiskGraph(context: AgentExecutionContext, checkpointer: BaseCheckpointSaver) {
  const graph = new StateGraph(RiskState)
    .addNode("collect", async (state: RiskAgentState) => {
      await emitNode(context, "collect", "正在并行获取项目、供应商、企业风险和制度证据");
      const toolCtx = toolContext(context);
      const [project, supplier, enterpriseRisk, bankStatement, policy] = await Promise.all([
        context.tools.execute("get_project_profile", { code: state.request.projectCode }, toolCtx),
        context.tools.execute("get_supplier_profile", { code: state.request.supplierCode }, toolCtx),
        context.tools.execute("get_enterprise_risks", { code: state.request.supplierCode }, toolCtx),
        context.tools.execute("get_bank_statement_summary", { code: state.request.supplierCode }, toolCtx),
        context.tools.execute("search_internal_policy", { query: "供应商失信与资金异常准入规则" }, toolCtx),
      ]);
      const evidence = [
        evidenceOf(context, "project", "business_object", state.request.projectCode, project),
        evidenceOf(context, "supplier", "business_object", state.request.supplierCode, supplier),
        evidenceOf(context, "enterprise-risk", "tool", "get_enterprise_risks", enterpriseRisk),
        evidenceOf(context, "bank-statement", "tool", "get_bank_statement_summary", bankStatement),
        evidenceOf(context, "policy", "knowledge", "supplier-policy", policy),
      ];
      for (const item of evidence) {
        await context.events.append(context.runId, {
          type: "evidence.added",
          nodeId: "collect",
          payload: { evidenceId: item.id, category: item.category },
        });
      }
      return {
        iteration: state.iteration + 1,
        evidence,
        toolResults: { project, supplier, enterpriseRisk, bankStatement, policy },
      };
    })
    .addNode("evaluate", async (state: RiskAgentState) => {
      await emitNode(context, "evaluate", "正在检查审查维度的证据覆盖情况");
      const required = ["project", "supplier", "enterprise-risk", "bank-statement", "policy"];
      const categories = new Set(state.evidence.map((item) => item.category));
      const covered = required.filter((category) => categories.has(category)).length;
      return { coverage: covered / required.length };
    })
    .addNode("synthesize", async (state: RiskAgentState) => {
      await emitNode(context, "synthesize", "正在基于证据生成结构化风险结论");
      const enterpriseRisk = state.toolResults.enterpriseRisk as {
        dishonest: boolean;
        legalCaseCount: number;
      };
      const bank = state.toolResults.bankStatement as {
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
      if (!decision.approved) {
        return { status: "cancelled" as const };
      }
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
    .addEdge(START, "collect")
    .addEdge("collect", "evaluate")
    .addConditionalEdges(
      "evaluate",
      (state) => (state.coverage >= 1 || state.iteration >= 2 ? "synthesize" : "collect"),
      { collect: "collect", synthesize: "synthesize" },
    )
    .addEdge("synthesize", "verify")
    .addConditionalEdges(
      "verify",
      (state) => (state.status === "failed" ? "end" : "human_review"),
      { end: END, human_review: "human_review" },
    )
    .addEdge("human_review", END);

  return graph.compile({ checkpointer });
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

function upsertEvidence(current: EvidenceRecord[], updates: EvidenceRecord[]): EvidenceRecord[] {
  const records = new Map(current.map((item) => [item.id, item]));
  for (const item of updates) records.set(item.id, item);
  return [...records.values()];
}
