import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AgentRegistry, AgentRuntime } from "@ear/agent-runtime";
import { InMemoryAgentEventStore, type AgentEvent } from "@ear/agent-protocol";
import type { AgentRunStatus, EvidenceRecord, RiskFinding } from "@ear/domain";
import {
  DeterministicEmbeddingProvider,
  ScriptedModelProvider,
} from "@ear/model-provider";
import {
  InMemoryKnowledgeRepository,
  InMemoryVectorIndex,
  KnowledgeIndexWorker,
  KnowledgeIngestionService,
  KnowledgeSearchService,
  type KnowledgeSearchResult,
} from "@ear/retrieval";
import { createRiskAgentDefinition, type RiskAgentState } from "@ear/risk-agent";
import {
  RuleBasedObjectPermissionPolicy,
  ToolRegistry,
  type ToolAuditRecord,
  type ToolDefinition,
} from "@ear/tool-registry";
import { z } from "zod";
import {
  RetrievalDatasetSchema,
  RiskDatasetSchema,
  TenantAttackDatasetSchema,
  type RetrievalDataset,
  type RiskEvaluationCase,
  type TenantAttackDataset,
} from "./schemas.js";

export interface RetrievalCaseResult {
  id: string;
  relevant: number;
  retrievedRelevant: number;
  recallAt5: number;
  returned: Array<{ tenantId: string; documentKey: string; section: string; score: number }>;
  passed: boolean;
}

export interface RiskCaseResult {
  id: string;
  status: AgentRunStatus;
  iterations: number;
  durationMs: number;
  evidenceValidity: number;
  citationAccuracy: number;
  candidateFindings: number;
  rejectedFindings: number;
  duplicateSideEffects: number;
  passed: boolean;
  issues: string[];
}

export interface SecurityCaseResult {
  id: string;
  leaks: number;
  passed: boolean;
}

export interface M2EvaluationReport {
  schemaVersion: "1.0";
  mode: "deterministic";
  generatedAt: string;
  gitRevision: string;
  datasets: {
    retrieval: string;
    risk: string;
    tenantAttacks: string;
  };
  retrieval: {
    cases: RetrievalCaseResult[];
    recallAt5: number;
  };
  risk: {
    cases: RiskCaseResult[];
    taskSuccessRate: number;
    evidenceValidity: number;
    citationAccuracy: number;
    candidateRejectionRate: number;
    duplicateSideEffects: number;
    p50DurationMs: number;
    p95DurationMs: number;
  };
  security: {
    cases: SecurityCaseResult[];
    tenantLeakage: number;
  };
  thresholds: {
    retrievalRecallAt5: boolean;
    citationAccuracy: boolean;
    evidenceValidity: boolean;
    candidateRejectionRate: boolean;
    tenantLeakage: boolean;
    duplicateSideEffects: boolean;
  };
  overallPassed: boolean;
  limitations: string[];
}

interface RetrievalHarness {
  search: KnowledgeSearchService;
  dataset: RetrievalDataset;
}

export interface EvaluationDatasets {
  retrieval: RetrievalDataset;
  risk: Awaited<ReturnType<typeof loadRiskDataset>>;
  tenantAttacks: TenantAttackDataset;
}

export type EvaluationDatasetVersion = "v1" | "v2";

export interface EvaluationRunOptions {
  datasetVersion?: EvaluationDatasetVersion;
}

export interface EvaluationToolOptions {
  knowledgeSearch?: Pick<KnowledgeSearchService, "search">;
  injectRealFailures?: boolean;
}

export async function runM2Evaluation(options: EvaluationRunOptions = {}): Promise<M2EvaluationReport> {
  const datasets = await loadEvaluationDatasets(options.datasetVersion);
  const retrievalDataset = datasets.retrieval;
  const riskDataset = datasets.risk;
  const attackDataset = datasets.tenantAttacks;
  const retrievalHarness = await createRetrievalHarness(retrievalDataset);
  const retrievalCases = await evaluateRetrieval(retrievalHarness);
  const riskCases = await Promise.all(riskDataset.cases.map(evaluateRiskCase));
  const securityCases = await evaluateTenantAttacks(retrievalHarness.search, attackDataset);
  const retrievalRecallAt5 = ratio(
    sum(retrievalCases.map((item) => item.retrievedRelevant)),
    sum(retrievalCases.map((item) => item.relevant)),
  );
  const evidenceValidity = average(riskCases.map((item) => item.evidenceValidity));
  const citationCases = riskCases.filter((item) => item.citationAccuracy >= 0);
  const citationAccuracy = average(citationCases.map((item) => item.citationAccuracy));
  const candidateFindings = sum(riskCases.map((item) => item.candidateFindings));
  const rejectedFindings = sum(riskCases.map((item) => item.rejectedFindings));
  const candidateRejectionRate = candidateFindings === 0 ? 0 : ratio(rejectedFindings, candidateFindings);
  const duplicateSideEffects = sum(riskCases.map((item) => item.duplicateSideEffects));
  const tenantLeakage = sum(securityCases.map((item) => item.leaks));
  const durations = riskCases.map((item) => item.durationMs);
  const thresholds = {
    retrievalRecallAt5: retrievalRecallAt5 >= 0.85,
    citationAccuracy: citationAccuracy >= 0.9,
    evidenceValidity: evidenceValidity === 1,
    candidateRejectionRate: candidateRejectionRate <= 0.1,
    tenantLeakage: tenantLeakage === 0,
    duplicateSideEffects: duplicateSideEffects === 0,
  };
  const taskSuccessRate = ratio(riskCases.filter((item) => item.passed).length, riskCases.length);
  return {
    schemaVersion: "1.0",
    mode: "deterministic",
    generatedAt: new Date().toISOString(),
    gitRevision: readGitRevision(),
    datasets: {
      retrieval: retrievalDataset.version,
      risk: riskDataset.version,
      tenantAttacks: attackDataset.version,
    },
    retrieval: { cases: retrievalCases, recallAt5: retrievalRecallAt5 },
    risk: {
      cases: riskCases,
      taskSuccessRate,
      evidenceValidity,
      citationAccuracy,
      candidateRejectionRate,
      duplicateSideEffects,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
    },
    security: { cases: securityCases, tenantLeakage },
    thresholds,
    overallPassed: Object.values(thresholds).every(Boolean) && taskSuccessRate === 1,
    limitations: [
      "E0 uses deterministic embeddings and a scripted model; these are harness baselines, not resume quality claims.",
      "Real PostgreSQL, Qdrant, Bailian model quality, token cost and recovery injection are measured in E1/E2.",
      "The E0 dataset is intentionally small and must be expanded before M2 exits.",
    ],
  };
}

export async function loadEvaluationDatasets(
  version: EvaluationDatasetVersion = "v1",
): Promise<EvaluationDatasets> {
  const [retrieval, risk, tenantAttacks] = await Promise.all([
    loadDataset(`retrieval.${version}.json`, RetrievalDatasetSchema),
    loadRiskDataset(version),
    loadDataset(`tenant-attacks.${version}.json`, TenantAttackDatasetSchema),
  ]);
  return { retrieval, risk, tenantAttacks };
}

async function loadRiskDataset(version: EvaluationDatasetVersion = "v1") {
  return loadDataset(`risk-cases.${version}.json`, RiskDatasetSchema);
}

async function createRetrievalHarness(dataset: RetrievalDataset): Promise<RetrievalHarness> {
  const repository = new InMemoryKnowledgeRepository();
  const embeddings = new DeterministicEmbeddingProvider(128);
  const index = new InMemoryVectorIndex();
  const ingestion = new KnowledgeIngestionService(repository);
  for (const document of dataset.documents) await ingestion.ingest(document);
  const indexed = await new KnowledgeIndexWorker(repository, embeddings, index).runOnce(100);
  if (indexed.failed.length > 0) throw new Error(`Evaluation indexing failed: ${indexed.failed.join(", ")}`);
  return { search: new KnowledgeSearchService(repository, embeddings, index), dataset };
}

async function evaluateRetrieval(harness: RetrievalHarness): Promise<RetrievalCaseResult[]> {
  return Promise.all(harness.dataset.cases.map(async (testCase) => {
    const results = await harness.search.search({
      tenantId: testCase.tenantId,
      query: testCase.query,
      limit: 5,
      permissionTags: testCase.permissionTags,
    });
    const relevant = new Set(testCase.relevant.map(stableChunkKey));
    const retrievedRelevant = new Set(
      results.filter((item) => relevant.has(stableChunkKey(item))).map(stableChunkKey),
    ).size;
    return {
      id: testCase.id,
      relevant: relevant.size,
      retrievedRelevant,
      recallAt5: ratio(retrievedRelevant, relevant.size),
      returned: results.map(toRetrievalSummary),
      passed: retrievedRelevant === relevant.size && results.every((item) => item.tenantId === testCase.tenantId),
    };
  }));
}

async function evaluateTenantAttacks(
  search: KnowledgeSearchService,
  dataset: TenantAttackDataset,
): Promise<SecurityCaseResult[]> {
  return Promise.all(dataset.cases.map(async (testCase) => {
    const results = await search.search({
      tenantId: testCase.tenantId,
      query: testCase.query,
      limit: 5,
      permissionTags: testCase.permissionTags,
    });
    const leaks = results.filter((item) =>
      testCase.forbiddenTenantIds.includes(item.tenantId) ||
      testCase.forbiddenSections.includes(item.section) ||
      testCase.forbiddenContent.some((marker) => item.content.includes(marker)),
    ).length;
    return { id: testCase.id, leaks, passed: leaks === 0 };
  }));
}

async function evaluateRiskCase(testCase: RiskEvaluationCase): Promise<RiskCaseResult> {
  const events = new InMemoryAgentEventStore();
  const audits: ToolAuditRecord[] = [];
  const tools = new ToolRegistry(
    async (audit) => {
      audits.push(audit);
      await events.append(audit.runId, {
        type: audit.status === "started"
          ? "tool.started"
          : audit.status === "completed"
            ? "tool.completed"
            : "tool.failed",
        payload: audit,
      });
    },
    undefined,
    new RuleBasedObjectPermissionPolicy([{ appName: "*", metaName: "*", action: "*" }]),
  );
  registerEvaluationTools(tools, testCase);
  const agents = new AgentRegistry();
  agents.register(createRiskAgentDefinition(undefined, createEvaluationModel(testCase)));
  const runtime = new AgentRuntime(agents, tools, events);
  const identity = {
    tenantId: testCase.tenantId,
    userId: `eval-reviewer-${testCase.tenantId}`,
    roles: ["risk_reviewer", "finance_reviewer"],
    scopes: ["risk:read", "risk:approve", "risk:write"],
  };
  const startedAt = performance.now();
  let run = await runtime.start("risk-agent", testCase.input, identity);
  if (testCase.approve && run.status === "waiting_approval") {
    run = await runtime.approve(run.id, identity);
  }
  const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const state = run.state as RiskAgentState;
  const history = await events.replay(run.id);
  const evidenceById = new Map(state.evidence.map((item) => [item.id, item]));
  const citations = state.findings.flatMap((finding) =>
    finding.evidenceIds.map((evidenceId) => ({ finding, evidence: evidenceById.get(evidenceId) })),
  );
  const validCitations = citations.filter((item) => item.evidence).length;
  const supportedCitations = citations.filter(({ finding, evidence }) =>
    evidence && testCase.expected.citationSupport[finding.dimension]?.includes(evidence.category),
  ).length;
  const completedWrites = audits.filter((audit) =>
    audit.toolName === "create_rectification_task" && audit.status === "completed",
  ).length;
  const issues = evaluateRiskExpectations(testCase, run.status, state, history);
  return {
    id: testCase.id,
    status: run.status,
    iterations: state.iteration,
    durationMs,
    evidenceValidity: ratio(validCitations, citations.length),
    citationAccuracy: citations.length === 0 ? -1 : ratio(supportedCitations, citations.length),
    candidateFindings: state.findings.length + state.rejectedFindings.length,
    rejectedFindings: state.rejectedFindings.length,
    duplicateSideEffects: Math.max(0, completedWrites - 1),
    passed: issues.length === 0,
    issues,
  };
}

export function evaluateRiskExpectations(
  testCase: RiskEvaluationCase,
  status: AgentRunStatus,
  state: RiskAgentState,
  events: AgentEvent[],
): string[] {
  const issues: string[] = [];
  if (status !== testCase.expected.status) issues.push(`status: expected ${testCase.expected.status}, got ${status}`);
  if (state.iteration !== testCase.expected.iterations) {
    issues.push(`iterations: expected ${testCase.expected.iterations}, got ${state.iteration}`);
  }
  compareSet("finding dimensions", state.findings.map((item) => item.dimension), testCase.expected.findingDimensions, issues);
  compareSet("evidence categories", state.evidence.map((item) => item.category), testCase.expected.evidenceCategories, issues);
  const eventTypes = new Set(events.map((item) => item.type));
  for (const required of testCase.expected.requiredEvents) {
    if (!eventTypes.has(required as AgentEvent["type"])) issues.push(`missing event: ${required}`);
  }
  const evidenceIds = new Set(state.evidence.map((item) => item.id));
  for (const finding of state.findings) {
    for (const evidenceId of finding.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) issues.push(`${finding.id} references missing evidence ${evidenceId}`);
    }
  }
  return issues;
}

function createEvaluationModel(testCase: RiskEvaluationCase): ScriptedModelProvider {
  const categoryTools: Record<string, string> = {
    project: "get_project_profile",
    supplier: "get_supplier_profile",
    "enterprise-risk": "get_enterprise_risks",
    "bank-statement": "get_bank_statement_summary",
    policy: "search_internal_policy",
  };
  return new ScriptedModelProvider({
    "risk.plan": ({ input, callIndex }) => {
      if (testCase.strategy === "invalid_plan") {
        return { rationale: "尝试调用未授权能力", tools: ["create_rectification_task", "unknown_tool"] };
      }
      if (testCase.strategy === "supplemental_loop" && callIndex === 0) {
        return {
          rationale: "先完成基础取证，再根据缺口补充资金证据",
          tools: [
            "get_project_profile",
            "get_supplier_profile",
            "get_enterprise_risks",
            "search_internal_policy",
          ],
        };
      }
      const missing = (input as { missingCategories: string[] }).missingCategories;
      return { rationale: "只选择当前缺失证据对应的只读工具", tools: missing.map((item) => categoryTools[item]) };
    },
    "risk.synthesize": ({ input }) => {
      const { toolResults } = input as { toolResults: Record<string, unknown> };
      const enterprise = toolResults.enterpriseRisk as { dishonest: boolean; legalCaseCount: number };
      const bank = toolResults.bankStatement as { abnormalTransactions: number; cashFlowStable: boolean };
      const findings: RiskFinding[] = [];
      if (enterprise.dishonest) {
        findings.push({
          id: `finding-credit-${testCase.id}`,
          dimension: "企业信用",
          level: "high",
          claim: `供应商存在失信记录，并涉及 ${enterprise.legalCaseCount} 条法律案件。`,
          evidenceIds: ["evidence-enterprise-risk", "evidence-policy"],
          confidence: 0.96,
          recommendation: "进入人工复核并补充案件说明材料。",
        });
      }
      if (!bank.cashFlowStable) {
        findings.push({
          id: `finding-cash-${testCase.id}`,
          dimension: "资金稳定性",
          level: "medium",
          claim: `发现 ${bank.abnormalTransactions} 笔异常交易，资金稳定性不足。`,
          evidenceIds: ["evidence-bank-statement", "evidence-policy"],
          confidence: 0.88,
          recommendation: "核验异常交易用途并增加履约保障。",
        });
      }
      return { findings };
    },
  });
}

export function registerEvaluationTools(
  registry: ToolRegistry,
  testCase: RiskEvaluationCase,
  options: EvaluationToolOptions = {},
): void {
  const fixture = testCase.fixture;
  const transientFailures = new Map(Object.entries(testCase.realFailToolAttempts));
  const shouldFail = (name: string): boolean => {
    if (fixture.failTools.includes(name)) return true;
    if (!options.injectRealFailures) return false;
    const remaining = transientFailures.get(name) ?? 0;
    if (remaining <= 0) return false;
    transientFailures.set(name, remaining - 1);
    return true;
  };
  const codeInput = z.object({ code: z.string().min(1) });
  const definitions: ToolDefinition<any, any>[] = [
    {
      name: "get_project_profile",
      description: "读取评测项目档案",
      access: "read",
      permission: ({ code }) => ({ appName: "std", metaName: "project", action: "view", objectId: code }),
      inputSchema: codeInput,
      outputSchema: z.object({ code: z.string(), name: z.string(), budget: z.number() }),
      execute: guardedTool("get_project_profile", shouldFail, async ({ code }) => ({ code, name: `${testCase.tenantId}评测项目`, budget: 12_000_000 })),
    },
    {
      name: "get_supplier_profile",
      description: "读取评测供应商档案",
      access: "read",
      permission: ({ code }) => ({ appName: "std", metaName: "supplier", action: "view", objectId: code }),
      inputSchema: codeInput,
      outputSchema: z.object({ code: z.string(), name: z.string(), registeredCapital: z.number() }),
      execute: guardedTool("get_supplier_profile", shouldFail, async ({ code }) => ({ code, name: `${testCase.tenantId}评测供应商`, registeredCapital: 2_000_000 })),
    },
    {
      name: "get_enterprise_risks",
      description: "读取评测企业风险",
      access: "read",
      permission: ({ code }) => ({ appName: "std", metaName: "supplier", action: "view", objectId: code }),
      inputSchema: codeInput,
      outputSchema: z.object({ dishonest: z.boolean(), legalCaseCount: z.number() }),
      execute: guardedTool("get_enterprise_risks", shouldFail, async () => fixture.enterpriseRisk),
    },
    {
      name: "get_bank_statement_summary",
      description: "读取评测银行流水摘要",
      access: "read",
      permission: ({ code }) => ({ appName: "std", metaName: "supplier", action: "view_finance_summary", objectId: code }),
      inputSchema: codeInput,
      outputSchema: z.object({ abnormalTransactions: z.number(), cashFlowStable: z.boolean() }),
      execute: guardedTool("get_bank_statement_summary", shouldFail, async () => fixture.bankStatement),
    },
    {
      name: "search_internal_policy",
      description: "读取评测租户制度",
      access: "read",
      permission: () => ({ appName: "knowledge", metaName: "supplier_policy", action: "view" }),
      inputSchema: z.object({ query: z.string().min(1) }),
      outputSchema: z.object({
        documentId: z.string(),
        documentKey: z.string(),
        documentVersion: z.number(),
        chunkId: z.string(),
        section: z.string(),
        locator: z.string(),
        content: z.string(),
        contentHash: z.string().optional(),
      }),
      execute: guardedTool("search_internal_policy", shouldFail, async ({ query }, context) => {
        if (options.knowledgeSearch) {
          const [result] = await options.knowledgeSearch.search({
            tenantId: context.identity.tenantId,
            query,
            limit: 1,
            permissionTags: context.identity.roles,
          });
          if (!result) throw new Error("No authorized evaluation policy found.");
          return result;
        }
        return {
          documentId: `${testCase.tenantId}-supplier-policy`,
          documentKey: "supplier-policy",
          documentVersion: 1,
          chunkId: `${testCase.tenantId}-supplier-policy-risk-review`,
          section: "失信复核",
          locator: JSON.stringify({ documentVersion: 1, section: "失信复核", startLine: 1, endLine: 2 }),
          content: `${testCase.tenantId}供应商风险必须依据本租户制度复核。`,
        };
      }),
    },
    {
      name: "create_rectification_task",
      description: "创建评测整改任务",
      access: "write",
      requiredScopes: ["risk:write"],
      permission: ({ caseId }) => ({ appName: "std", metaName: "rectification_task", action: "create", objectId: caseId }),
      inputSchema: z.object({ caseId: z.string(), findingIds: z.array(z.string()).min(1) }),
      outputSchema: z.object({ taskId: z.string(), created: z.boolean() }),
      execute: guardedTool("create_rectification_task", shouldFail, async ({ caseId }) => ({ taskId: `rectification-${caseId}`, created: true })),
    },
  ];
  for (const definition of definitions) registry.register(definition);
}

function guardedTool<TInput, TOutput>(
  name: string,
  shouldFail: (name: string) => boolean,
  execute: (input: TInput, context: { identity: { tenantId: string; roles?: string[] } }) => Promise<TOutput>,
): (input: TInput, context: { identity: { tenantId: string; roles?: string[] } }) => Promise<TOutput> {
  return async (input, context) => {
    if (shouldFail(name)) throw new Error(`Injected evaluation failure: ${name}`);
    return execute(input, context);
  };
}

function stableChunkKey(input: { documentKey: string; section: string }): string {
  return `${input.documentKey}::${input.section}`;
}

function toRetrievalSummary(item: KnowledgeSearchResult) {
  return {
    tenantId: item.tenantId,
    documentKey: item.documentKey,
    section: item.section,
    score: Math.round(item.score * 10_000) / 10_000,
  };
}

function compareSet(label: string, actual: string[], expected: string[], issues: string[]): void {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    issues.push(`${label}: expected ${right.join(", ") || "none"}, got ${left.join(", ") || "none"}`);
  }
}

async function loadDataset<T>(filename: string, schema: z.ZodType<T>): Promise<T> {
  const path = fileURLToPath(new URL(`../datasets/${filename}`, import.meta.url));
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function average(values: number[]): number {
  return ratio(sum(values), values.length);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentileValue * sorted.length) - 1] ?? 0;
}

function readGitRevision(): string {
  try {
    const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirty ? `${revision}-dirty` : revision;
  } catch {
    return "unknown";
  }
}
