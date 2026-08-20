import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { AgentRegistry, AgentRuntime } from "@ear/agent-runtime";
import type { AgentEvent } from "@ear/agent-protocol";
import type { AgentRunStatus, RiskFinding } from "@ear/domain";
import {
  BailianChatCompletionsModelProvider,
  OpenAIEmbeddingProvider,
} from "@ear/model-provider";
import {
  createDatabaseConnection,
  migrateDatabase,
} from "@ear/persistence";
import {
  KnowledgeIndexWorker,
  KnowledgeIngestionService,
  KnowledgeSearchService,
  QdrantVectorIndex,
  type KnowledgeSearchResult,
} from "@ear/retrieval";
import { createRiskAgentDefinition, type RiskAgentState } from "@ear/risk-agent";
import { ToolRegistry, type ToolAuditRecord } from "@ear/tool-registry";
import { createPostgresInfrastructure } from "../../apps/api/src/infrastructure.js";
import {
  evaluateRiskExpectations,
  loadEvaluationDatasets,
  registerEvaluationTools,
  type RiskCaseResult,
  type RetrievalCaseResult,
  type SecurityCaseResult,
} from "./evaluator.js";

export interface ProviderCallRecord {
  operation: string;
  endpoint: "embeddings" | "chat_completions";
  model: string;
  status: "completed" | "failed";
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  error?: string;
}

export interface RealM2EvaluationReport {
  schemaVersion: "1.0";
  mode: "real";
  generatedAt: string;
  gitRevision: string;
  providers: {
    model: string;
    embedding: string;
    embeddingDimensions: number;
    database: "postgresql";
    vectorIndex: "qdrant";
  };
  datasets: { retrieval: string; risk: string; tenantAttacks: string };
  retrieval: { cases: RetrievalCaseResult[]; recallAt5: number };
  risk: {
    cases: RiskCaseResult[];
    taskSuccessRate: number;
    evidenceValidity: number;
    citationAccuracy: number;
    duplicateSideEffects: number;
    p50DurationMs: number;
    p95DurationMs: number;
  };
  security: { cases: SecurityCaseResult[]; tenantLeakage: number };
  usage: {
    calls: ProviderCallRecord[];
    inputTokens: number;
    outputTokens: number;
    embeddingTokens: number;
    totalTokens: number;
    estimatedCostCny: number;
    ratesCnyPerMillion: { modelInput: number; modelOutput: number; embeddingInput: number };
  };
  thresholds: Record<string, boolean>;
  overallPassed: boolean;
  limitations: string[];
}

export async function runRealM2Evaluation(): Promise<RealM2EvaluationReport> {
  const config = readRealConfig();
  const datasets = await loadEvaluationDatasets();
  const calls: ProviderCallRecord[] = [];
  const temporary = await createTemporaryDatabase(config.databaseUrl);
  const collection = `ear_eval_${temporary.name}`;
  const qdrant = new QdrantVectorIndex({
    url: config.qdrantUrl,
    collection,
    ...(config.qdrantApiKey ? { apiKey: config.qdrantApiKey } : {}),
  });
  let infrastructure: Awaited<ReturnType<typeof createPostgresInfrastructure>> | undefined;
  try {
    const connection = createDatabaseConnection(temporary.url);
    try {
      await migrateDatabase(connection.db, fileURLToPath(new URL("../../drizzle", import.meta.url)));
    } finally {
      await connection.close();
    }
    infrastructure = await createPostgresInfrastructure(temporary.url);

    const embeddings = new OpenAIEmbeddingProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.embeddingModel,
      dimensions: config.embeddingDimensions,
      fetchImpl: observedFetch("knowledge.embedding", calls),
    });
    const ingestion = new KnowledgeIngestionService(infrastructure.knowledge);
    for (const document of datasets.retrieval.documents) await ingestion.ingest(document);
    const indexing = await new KnowledgeIndexWorker(infrastructure.knowledge, embeddings, qdrant)
      .runOnce(100);
    if (indexing.failed.length > 0) {
      throw new Error(`Real indexing failed for ${indexing.failed.length} documents.`);
    }
    const search = new KnowledgeSearchService(infrastructure.knowledge, embeddings, qdrant);
    const retrievalCases = await evaluateRealRetrieval(search, datasets.retrieval.cases);
    const securityCases = await evaluateRealAttacks(search, datasets.tenantAttacks.cases);
    const eligibleRiskCases = datasets.risk.cases.filter((item) => item.realEligible);
    const riskCases: RiskCaseResult[] = [];
    for (const testCase of eligibleRiskCases) {
      riskCases.push(await evaluateRealRiskCase(testCase, infrastructure, search, config, calls));
    }
    return buildReport({
      config,
      datasets: {
        retrieval: datasets.retrieval.version,
        risk: datasets.risk.version,
        tenantAttacks: datasets.tenantAttacks.version,
      },
      retrievalCases,
      riskCases,
      securityCases,
      calls,
    });
  } finally {
    await infrastructure?.close().catch(() => undefined);
    await deleteQdrantCollection(config.qdrantUrl, collection, config.qdrantApiKey);
    await temporary.drop();
  }
}

async function evaluateRealRetrieval(
  search: KnowledgeSearchService,
  cases: Awaited<ReturnType<typeof loadEvaluationDatasets>>["retrieval"]["cases"],
): Promise<RetrievalCaseResult[]> {
  const output: RetrievalCaseResult[] = [];
  for (const testCase of cases) {
    const results = await search.search({
      tenantId: testCase.tenantId,
      query: testCase.query,
      limit: 5,
      permissionTags: testCase.permissionTags,
    });
    const relevant = new Set(testCase.relevant.map(stableChunkKey));
    const retrievedRelevant = new Set(
      results.filter((item) => relevant.has(stableChunkKey(item))).map(stableChunkKey),
    ).size;
    output.push({
      id: testCase.id,
      relevant: relevant.size,
      retrievedRelevant,
      recallAt5: ratio(retrievedRelevant, relevant.size),
      returned: results.map(toRetrievalSummary),
      passed: retrievedRelevant === relevant.size && results.every((item) => item.tenantId === testCase.tenantId),
    });
  }
  return output;
}

async function evaluateRealAttacks(
  search: KnowledgeSearchService,
  cases: Awaited<ReturnType<typeof loadEvaluationDatasets>>["tenantAttacks"]["cases"],
): Promise<SecurityCaseResult[]> {
  const output: SecurityCaseResult[] = [];
  for (const testCase of cases) {
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
    output.push({ id: testCase.id, leaks, passed: leaks === 0 });
  }
  return output;
}

async function evaluateRealRiskCase(
  testCase: Awaited<ReturnType<typeof loadEvaluationDatasets>>["risk"]["cases"][number],
  infrastructure: Awaited<ReturnType<typeof createPostgresInfrastructure>>,
  search: KnowledgeSearchService,
  config: ReturnType<typeof readRealConfig>,
  calls: ProviderCallRecord[],
): Promise<RiskCaseResult> {
  const audits: ToolAuditRecord[] = [];
  const tools = new ToolRegistry(
    async (audit) => {
      audits.push(audit);
      await infrastructure.toolAudit?.(audit);
      await infrastructure.events.append(audit.runId, {
        type: audit.status === "started"
          ? "tool.started"
          : audit.status === "completed"
            ? "tool.completed"
            : "tool.failed",
        payload: audit,
      });
    },
    infrastructure.idempotency,
    infrastructure.objectPermissions,
  );
  registerEvaluationTools(tools, testCase, {
    knowledgeSearch: search,
    injectRealFailures: true,
  });
  const model = new BailianChatCompletionsModelProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    fetchImpl: observedFetch(`risk.${testCase.id}`, calls),
  });
  const agents = new AgentRegistry();
  agents.register(createRiskAgentDefinition(infrastructure.checkpointer, model));
  const runtime = new AgentRuntime(agents, tools, infrastructure.events, infrastructure.runs);
  const identity = {
    tenantId: testCase.tenantId,
    userId: `real-eval-${testCase.tenantId}`,
    roles: ["risk_reviewer", "finance_reviewer"],
    scopes: ["risk:read", "risk:approve", "risk:write"],
  };
  const startedAt = performance.now();
  let run = await runtime.start("risk-agent", testCase.input, identity);
  if (testCase.approve && run.status === "waiting_approval") run = await runtime.approve(run.id, identity);
  const durationMs = round(performance.now() - startedAt, 2);
  const state = normalizeRiskState(run.state, testCase.input, run.status);
  const history = await infrastructure.events.replay(run.id);
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
    duplicateSideEffects: Math.max(0, completedWrites - 1),
    passed: issues.length === 0,
    issues,
  };
}

function buildReport(input: {
  config: ReturnType<typeof readRealConfig>;
  datasets: RealM2EvaluationReport["datasets"];
  retrievalCases: RetrievalCaseResult[];
  riskCases: RiskCaseResult[];
  securityCases: SecurityCaseResult[];
  calls: ProviderCallRecord[];
}): RealM2EvaluationReport {
  const retrievalRecall = ratio(
    sum(input.retrievalCases.map((item) => item.retrievedRelevant)),
    sum(input.retrievalCases.map((item) => item.relevant)),
  );
  const citationCases = input.riskCases.filter((item) => item.citationAccuracy >= 0);
  const citationAccuracy = average(citationCases.map((item) => item.citationAccuracy));
  const evidenceValidity = average(input.riskCases.map((item) => item.evidenceValidity));
  const duplicateSideEffects = sum(input.riskCases.map((item) => item.duplicateSideEffects));
  const tenantLeakage = sum(input.securityCases.map((item) => item.leaks));
  const inputTokens = sum(input.calls.filter(isModelCall).map((item) => item.inputTokens));
  const outputTokens = sum(input.calls.filter(isModelCall).map((item) => item.outputTokens));
  const embeddingTokens = sum(input.calls.filter((item) => item.endpoint === "embeddings").map((item) => item.inputTokens));
  const estimatedCostCny = round(
    inputTokens / 1_000_000 * input.config.rates.modelInput +
    outputTokens / 1_000_000 * input.config.rates.modelOutput +
    embeddingTokens / 1_000_000 * input.config.rates.embeddingInput,
    6,
  );
  const taskSuccessRate = ratio(input.riskCases.filter((item) => item.passed).length, input.riskCases.length);
  const thresholds = {
    retrievalRecallAt5: retrievalRecall >= 0.85,
    citationAccuracy: citationAccuracy >= 0.9,
    evidenceValidity: evidenceValidity === 1,
    tenantLeakage: tenantLeakage === 0,
    duplicateSideEffects: duplicateSideEffects === 0,
  };
  const durations = input.riskCases.map((item) => item.durationMs);
  return {
    schemaVersion: "1.0",
    mode: "real",
    generatedAt: new Date().toISOString(),
    gitRevision: readGitRevision(),
    providers: {
      model: input.config.model,
      embedding: input.config.embeddingModel,
      embeddingDimensions: input.config.embeddingDimensions,
      database: "postgresql",
      vectorIndex: "qdrant",
    },
    datasets: input.datasets,
    retrieval: { cases: input.retrievalCases, recallAt5: retrievalRecall },
    risk: {
      cases: input.riskCases,
      taskSuccessRate,
      evidenceValidity,
      citationAccuracy,
      duplicateSideEffects,
      p50DurationMs: percentile(durations, 0.5),
      p95DurationMs: percentile(durations, 0.95),
    },
    security: { cases: input.securityCases, tenantLeakage },
    usage: {
      calls: input.calls,
      inputTokens,
      outputTokens,
      embeddingTokens,
      totalTokens: inputTokens + outputTokens + embeddingTokens,
      estimatedCostCny,
      ratesCnyPerMillion: input.config.rates,
    },
    thresholds,
    overallPassed: Object.values(thresholds).every(Boolean) && taskSuccessRate === 1,
    limitations: [
      "This E1 baseline uses a small 8/5/3 dataset and must not be presented as the final 30/20/10 benchmark.",
      "Cost is estimated from configured unit rates; the Bailian billing console remains the billing source of truth.",
      "Recovery fault injection and three-run variance are deferred to E2.",
    ],
  };
}

function observedFetch(operation: string, sink: ProviderCallRecord[]): typeof fetch {
  return async (input, init) => {
    const startedAt = performance.now();
    const endpoint = String(input).endsWith("/embeddings") ? "embeddings" : "chat_completions";
    const requestBody = typeof init?.body === "string" ? safeJson(init.body) : {};
    try {
      const response = await fetch(input, init);
      const body = await response.clone().json().catch(() => ({})) as {
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        };
      };
      const inputTokens = body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0;
      const outputTokens = body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0;
      sink.push({
        operation,
        endpoint,
        model: String((requestBody as { model?: unknown }).model ?? "unknown"),
        status: response.ok ? "completed" : "failed",
        durationMs: round(performance.now() - startedAt, 2),
        inputTokens,
        outputTokens,
        totalTokens: body.usage?.total_tokens ?? inputTokens + outputTokens,
        ...(!response.ok ? { error: `HTTP ${response.status}` } : {}),
      });
      return response;
    } catch (error) {
      sink.push({
        operation,
        endpoint,
        model: String((requestBody as { model?: unknown }).model ?? "unknown"),
        status: "failed",
        durationMs: round(performance.now() - startedAt, 2),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}

async function createTemporaryDatabase(databaseUrl: string): Promise<{
  name: string;
  url: string;
  drop(): Promise<void>;
}> {
  const name = `ear_eval_${Date.now()}_${randomUUID().slice(0, 8).replaceAll("-", "")}`;
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const evalUrl = new URL(databaseUrl);
  evalUrl.pathname = `/${name}`;
  const admin = new Pool({ connectionString: adminUrl.toString() });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  return {
    name,
    url: evalUrl.toString(),
    async drop() {
      const pool = new Pool({ connectionString: adminUrl.toString() });
      try {
        await pool.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [name],
        );
        await pool.query(`DROP DATABASE IF EXISTS "${name}"`);
      } finally {
        await pool.end();
      }
    },
  };
}

async function deleteQdrantCollection(url: string, collection: string, apiKey?: string): Promise<void> {
  await fetch(`${url.replace(/\/$/, "")}/collections/${collection}`, {
    method: "DELETE",
    headers: apiKey ? { "api-key": apiKey } : {},
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
}

function readRealConfig() {
  return {
    databaseUrl: requiredEnvironment("DATABASE_URL"),
    qdrantUrl: requiredEnvironment("QDRANT_URL"),
    qdrantApiKey: process.env.QDRANT_API_KEY,
    apiKey: requiredEnvironment("OPENAI_API_KEY"),
    baseUrl: requiredEnvironment("OPENAI_BASE_URL"),
    model: requiredEnvironment("OPENAI_MODEL"),
    embeddingModel: requiredEnvironment("OPENAI_EMBEDDING_MODEL"),
    embeddingDimensions: positiveInteger("EMBEDDING_DIMENSIONS"),
    rates: {
      modelInput: positiveNumber("EVAL_MODEL_INPUT_CNY_PER_MILLION", 12),
      modelOutput: positiveNumber("EVAL_MODEL_OUTPUT_CNY_PER_MILLION", 36),
      embeddingInput: positiveNumber("EVAL_EMBEDDING_CNY_PER_MILLION", 0.5),
    },
  };
}

function normalizeRiskState(raw: unknown, request: RiskEvaluationCaseInput, status: AgentRunStatus): RiskAgentState {
  const state = raw as Partial<RiskAgentState>;
  return {
    request,
    status,
    iteration: state.iteration ?? 0,
    selectedTools: state.selectedTools ?? [],
    successfulTools: state.successfulTools ?? [],
    missingCategories: state.missingCategories ?? [],
    planIssues: state.planIssues ?? [],
    evidence: state.evidence ?? [],
    findings: state.findings ?? [],
    coverage: state.coverage ?? 0,
    toolResults: state.toolResults ?? {},
    toolFailures: state.toolFailures ?? {},
    verificationIssues: state.verificationIssues ?? [],
    ...(state.writeBack ? { writeBack: state.writeBack } : {}),
  };
}

type RiskEvaluationCaseInput = Awaited<ReturnType<typeof loadEvaluationDatasets>>["risk"]["cases"][number]["input"];

function stableChunkKey(input: { documentKey: string; section: string }): string {
  return `${input.documentKey}::${input.section}`;
}

function toRetrievalSummary(item: KnowledgeSearchResult) {
  return { tenantId: item.tenantId, documentKey: item.documentKey, section: item.section, score: round(item.score, 4) };
}

function isModelCall(item: ProviderCallRecord): boolean {
  return item.endpoint === "chat_completions";
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return {}; }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number.`);
  return value;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : round(numerator / denominator, 4);
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

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function readGitRevision(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}
