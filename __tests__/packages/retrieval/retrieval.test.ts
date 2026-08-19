import {
  InMemoryKnowledgeRepository,
  InMemoryVectorIndex,
  KnowledgeIndexWorker,
  KnowledgeIngestionService,
  KnowledgeSearchService,
  QdrantVectorIndex,
  splitMarkdownIntoChunks,
} from "@ear/retrieval";
import { DeterministicEmbeddingProvider } from "@ear/model-provider";
import { AgentRegistry, AgentRuntime } from "@ear/agent-runtime";
import { InMemoryAgentEventStore } from "@ear/agent-protocol";
import {
  createRiskAgentDefinition,
  registerMockPaasTools,
  type RiskAgentState,
} from "@ear/risk-agent";
import { RuleBasedObjectPermissionPolicy, ToolRegistry } from "@ear/tool-registry";
import { describe, expect, it, vi } from "vitest";

describe("Knowledge Retrieval", () => {
  it("应按Markdown章节切分并保留行号定位", () => {
    const chunks = splitMarkdownIntoChunks([
      "# 供应商准入制度",
      "总则。",
      "",
      "## 高风险供应商",
      "存在失信记录时必须人工复核。",
    ].join("\n"));

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({
      section: "高风险供应商",
      startLine: 4,
      endLine: 5,
    });
  });

  it("应隔离租户并在发布新版本后只检索活动版本", async () => {
    const repository = new InMemoryKnowledgeRepository();
    const embeddings = new DeterministicEmbeddingProvider(64);
    const index = new InMemoryVectorIndex();
    const ingestion = new KnowledgeIngestionService(repository);
    const worker = new KnowledgeIndexWorker(repository, embeddings, index);
    const search = new KnowledgeSearchService(repository, embeddings, index);

    await ingestion.ingest({
      tenantId: "tenant-a",
      userId: "admin-a",
      documentKey: "supplier-policy",
      version: 1,
      title: "A租户供应商制度",
      content: "# 准入规则\n存在失信记录时必须人工复核。",
      permissionTags: [],
    });
    await ingestion.ingest({
      tenantId: "tenant-b",
      userId: "admin-b",
      documentKey: "supplier-policy",
      version: 1,
      title: "B租户供应商制度",
      content: "# 准入规则\n存在失信记录时可以直接准入。",
      permissionTags: [],
    });
    await worker.runOnce();

    const tenantA = await search.search({
      tenantId: "tenant-a",
      query: "失信记录如何复核",
      limit: 5,
    });
    expect(tenantA).toHaveLength(1);
    expect(tenantA[0]).toMatchObject({ tenantId: "tenant-a", documentVersion: 1 });
    expect(tenantA[0]?.content).toContain("必须人工复核");

    await ingestion.ingest({
      tenantId: "tenant-a",
      userId: "admin-a",
      documentKey: "supplier-policy",
      version: 2,
      title: "A租户供应商制度",
      content: "# 准入规则\n存在失信记录时必须补充担保并由风控负责人复核。",
      permissionTags: [],
    });
    await worker.runOnce();
    const active = await search.search({
      tenantId: "tenant-a",
      query: "失信记录复核",
      limit: 5,
    });

    expect(active.every((item) => item.documentVersion === 2)).toBe(true);
    expect(await repository.getDocumentVersion("tenant-a", "supplier-policy", 1))
      .toMatchObject({ version: 1, status: "archived" });
  });

  it("旧版本任务晚于新版本执行时应跳过归档文档", async () => {
    const repository = new InMemoryKnowledgeRepository();
    const embeddings = new DeterministicEmbeddingProvider(32);
    const index = new InMemoryVectorIndex();
    const ingestion = new KnowledgeIngestionService(repository);
    const worker = new KnowledgeIndexWorker(repository, embeddings, index);
    const first = await ingestion.ingest({
      tenantId: "tenant-a",
      userId: "admin-a",
      documentKey: "supplier-policy",
      version: 1,
      title: "旧制度",
      content: "# 旧制度\n允许直接准入。",
      permissionTags: [],
    });
    const second = await ingestion.ingest({
      tenantId: "tenant-a",
      userId: "admin-a",
      documentKey: "supplier-policy",
      version: 2,
      title: "新制度",
      content: "# 新制度\n必须人工复核。",
      permissionTags: [],
    });

    const result = await worker.runOnce();

    expect(result.skipped).toContain(first.id);
    expect(result.indexed).toContain(second.id);
  });

  it("Qdrant查询必须携带tenant_id过滤条件", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/collections/knowledge_chunks")) {
        return new Response("{}", { status: init?.method === "GET" ? 404 : 200 });
      }
      if (url.endsWith("/points/query")) {
        return new Response(
          JSON.stringify({ result: { points: [{ id: "chunk-1", score: 0.9 }] } }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    });
    const index = new QdrantVectorIndex({
      url: "http://qdrant.test:6333",
      collection: "knowledge_chunks",
      fetchImpl,
    });
    await index.ensureCollection(3);
    await index.search({ tenantId: "tenant-a", vector: [1, 0, 0], limit: 3 });

    const queryCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/points/query"));
    const body = JSON.parse(String(queryCall?.[1]?.body));
    expect(body.filter.must).toContainEqual({
      key: "tenant_id",
      match: { value: "tenant-a" },
    });
  });

  it("风控Agent的制度证据应定位到真实文档版本和行号", async () => {
    const repository = new InMemoryKnowledgeRepository();
    const embeddings = new DeterministicEmbeddingProvider(64);
    const index = new InMemoryVectorIndex();
    const ingestion = new KnowledgeIngestionService(repository);
    const worker = new KnowledgeIndexWorker(repository, embeddings, index);
    const search = new KnowledgeSearchService(repository, embeddings, index);
    const document = await ingestion.ingest({
      tenantId: "tenant-a",
      userId: "admin-a",
      documentKey: "supplier-policy",
      version: 7,
      title: "供应商准入制度",
      content: "# 高风险供应商\n存在失信记录或重大资金异常时必须人工复核。",
      permissionTags: ["risk_reviewer"],
    });
    await worker.runOnce();
    const tools = new ToolRegistry(
      undefined,
      undefined,
      new RuleBasedObjectPermissionPolicy([
        { appName: "*", metaName: "*", action: "*" },
      ]),
    );
    registerMockPaasTools(tools, { knowledgeSearch: search });
    const agents = new AgentRegistry();
    agents.register(createRiskAgentDefinition());
    const runtime = new AgentRuntime(agents, tools, new InMemoryAgentEventStore());

    const run = await runtime.start(
      "risk-agent",
      { caseId: "case-rag", projectCode: "P-1", supplierCode: "S-1" },
      { tenantId: "tenant-a", userId: "reviewer-a", roles: ["risk_reviewer"] },
    );
    const policy = (run.state as RiskAgentState).evidence.find(
      (item) => item.id === "evidence-policy",
    );

    expect(policy).toMatchObject({
      sourceType: "knowledge",
      sourceId: document.id,
      content: expect.stringContaining("必须人工复核"),
    });
    expect(JSON.parse(policy!.locator!)).toMatchObject({
      documentVersion: 7,
      section: "高风险供应商",
      startLine: 1,
      endLine: 2,
    });
  });
});
