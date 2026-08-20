import type { AgentDefinition, AgentExecutionContext } from "@ear/agent-runtime";
import type { EvidenceRecord, RiskFinding } from "@ear/domain";
import { registerPaasObjectTools, type PaasObjectGateway, type PaasObjectMetadata } from "@ear/paas-metadata";
import type { ToolRegistry } from "@ear/tool-registry";
import { z } from "zod";

export const ContractReviewInputSchema = z.object({
  contractId: z.string().min(1),
  supplierCode: z.string().min(1),
});
export type ContractReviewInput = z.infer<typeof ContractReviewInputSchema>;

export interface ContractAgentState {
  status: "waiting_approval" | "completed";
  evidence: EvidenceRecord[];
  findings: RiskFinding[];
  writeBack?: { taskId: string; created: boolean };
}

export function createContractAgentDefinition(): AgentDefinition<ContractReviewInput, ContractAgentState> {
  return {
    id: "contract-agent",
    name: "合同条款合规审查 Agent",
    version: "0.1.0",
    approvalScopes: ["contract:approve", "contract:write"],
    inputSchema: ContractReviewInputSchema,
    async start(input, context) {
      await emit(context, "node.started", { node: "contract.collect" });
      const [contract, policy] = await Promise.all([
        context.tools.execute<ContractToolOutput>(
          "paas_contract_get",
          { objectId: input.contractId },
          toolContext(context),
        ),
        context.tools.execute<PolicyOutput>(
          "get_contract_policy",
          { supplierCode: input.supplierCode },
          toolContext(context),
        ),
      ]);
      const evidence = createEvidence(context, input, contract, policy);
      for (const item of evidence) {
        await emit(context, "evidence.added", item);
      }
      const findings = createFindings(contract.record, policy, evidence);
      if (findings.length === 0) {
        const state: ContractAgentState = { status: "completed", evidence, findings };
        await emit(context, "run.completed", { findingCount: 0 });
        return { status: state.status, state, evidence, findings };
      }
      const state: ContractAgentState = { status: "waiting_approval", evidence, findings };
      await emit(context, "approval.required", {
        findingCount: findings.length,
        action: "create_contract_review_task",
      });
      return { status: state.status, state, evidence, findings };
    },
    async approve(state, context) {
      return completeContractReview(state, context, context.identity.userId);
    },
    async recoverApproved(state, approvedBy, context) {
      if (state.status === "completed") {
        return { status: state.status, state, evidence: state.evidence, findings: state.findings };
      }
      return completeContractReview(state, context, approvedBy);
    },
  };
}

export function registerContractTools(
  registry: ToolRegistry,
  gateway: PaasObjectGateway = new DemoContractGateway(),
): void {
  registerPaasObjectTools(registry, contractMetadata, gateway, { operations: ["get"] });
  registry.register({
    name: "get_contract_policy",
    description: "读取当前租户的合同付款与责任条款基线",
    access: "read",
    requiredScopes: ["contract:read"],
    permission: () => ({ appName: "knowledge", metaName: "contract_policy", action: "view" }),
    inputSchema: z.object({ supplierCode: z.string().min(1) }).strict(),
    outputSchema: z.object({ maxAdvanceRatio: z.number(), liabilityCapRequired: z.boolean() }).strict(),
    async execute() {
      return { maxAdvanceRatio: 0.3, liabilityCapRequired: true };
    },
  });
  registry.register({
    name: "create_contract_review_task",
    description: "为已审批的合同合规问题创建复核任务",
    access: "write",
    requiredScopes: ["contract:write"],
    permission: ({ contractId }) => ({
      appName: "std",
      metaName: "contract_review_task",
      action: "create",
      objectId: contractId,
    }),
    inputSchema: z.object({ contractId: z.string().min(1), findingIds: z.array(z.string()).min(1) }).strict(),
    outputSchema: z.object({ taskId: z.string(), created: z.boolean() }).strict(),
    async execute({ contractId }) {
      return { taskId: `contract-review-${contractId}`, created: true };
    },
  });
}

async function completeContractReview(
  state: ContractAgentState,
  context: AgentExecutionContext,
  approvedBy: string,
) {
  const contractId = state.evidence[0]?.sourceId;
  if (!contractId) throw new Error("Contract evidence is missing");
  const writeBack = await context.tools.execute<{ taskId: string; created: boolean }>(
    "create_contract_review_task",
    { contractId, findingIds: state.findings.map((item) => item.id) },
    toolContext(context),
    {
      approval: { approved: true, approvedBy },
      idempotencyKey: `${context.runId}:contract-review-task`,
    },
  );
  const completed: ContractAgentState = { ...state, status: "completed", writeBack };
  await emit(context, "approval.completed", { approvedBy });
  await emit(context, "run.completed", { writeBack });
  return { status: completed.status, state: completed, evidence: state.evidence, findings: state.findings };
}

function createEvidence(
  context: AgentExecutionContext,
  input: ContractReviewInput,
  contract: ContractToolOutput,
  policy: PolicyOutput,
): EvidenceRecord[] {
  const now = new Date().toISOString();
  return [
    {
      id: `${context.runId}:contract`,
      tenantId: context.identity.tenantId,
      runId: context.runId,
      category: "contract",
      sourceType: "business_object",
      sourceId: input.contractId,
      content: JSON.stringify(contract.record),
      locator: `meta:Contract@${contract.metadataVersion}`,
      collectedAt: now,
    },
    {
      id: `${context.runId}:policy`,
      tenantId: context.identity.tenantId,
      runId: context.runId,
      category: "contract-policy",
      sourceType: "knowledge",
      sourceId: "contract-policy-v1",
      content: JSON.stringify(policy),
      locator: "contract-policy#payment-and-liability",
      collectedAt: now,
    },
  ];
}

function createFindings(
  record: Record<string, unknown>,
  policy: PolicyOutput,
  evidence: EvidenceRecord[],
): RiskFinding[] {
  const findings: RiskFinding[] = [];
  if (Number(record.advanceRatio) > policy.maxAdvanceRatio) {
    findings.push(finding("advance-ratio", "预付款比例超过制度上限", evidence));
  }
  if (policy.liabilityCapRequired && record.hasLiabilityCap !== true) {
    findings.push(finding("liability-cap", "合同缺少责任上限条款", evidence));
  }
  return findings;
}

function finding(id: string, claim: string, evidence: EvidenceRecord[]): RiskFinding {
  return {
    id,
    dimension: "contract-compliance",
    level: "high",
    claim,
    evidenceIds: evidence.map((item) => item.id),
    confidence: 1,
    recommendation: "人工确认后创建合同复核任务",
  };
}

function toolContext(context: AgentExecutionContext) {
  return { runId: context.runId, identity: context.identity };
}

function emit(context: AgentExecutionContext, type: Parameters<AgentExecutionContext["events"]["append"]>[1]["type"], payload: unknown) {
  return context.events.append(context.runId, { type, payload });
}

interface ContractToolOutput { metadataVersion: string; record: Record<string, unknown> }
interface PolicyOutput { maxAdvanceRatio: number; liabilityCapRequired: boolean }

const contractMetadata = {
  source: "rn-paas-snapshot",
  version: "contract-demo-v1",
  appName: "std",
  metaName: "Contract",
  label: "合同档案",
  actions: { get: { permissionAction: "view", requiredScopes: ["contract:read"] } },
  fields: [
    field("code", "合同编码", "AutoCode"),
    field("name", "合同名称", "Text"),
    field("amount", "合同金额", "Currency"),
    field("advanceRatio", "预付款比例", "Percent"),
    field("hasLiabilityCap", "是否包含责任上限", "Boolean"),
  ],
} satisfies PaasObjectMetadata;

function field(name: string, label: string, type: PaasObjectMetadata["fields"][number]["type"]) {
  return {
    name,
    label,
    type,
    readOnly: 1 as const,
    permissions: { read: true, create: false, update: false },
    policy: { read: "plain" as const, write: "deny" as const },
  };
}

class DemoContractGateway implements PaasObjectGateway {
  async get({ objectId, context }: Parameters<PaasObjectGateway["get"]>[0]) {
    return {
      code: objectId,
      name: `${context.identity.tenantId}示例采购合同`,
      amount: 3_000_000,
      advanceRatio: 0.6,
      hasLiabilityCap: false,
    };
  }
  async create(): Promise<Record<string, unknown>> { throw new Error("Demo contract create is disabled"); }
  async update(): Promise<Record<string, unknown>> { throw new Error("Demo contract update is disabled"); }
}
