import { randomUUID } from "node:crypto";
import { DeterministicEmbeddingProvider } from "@ear/model-provider";
import {
  createDatabaseConnection,
  PostgresKnowledgeRepository,
} from "@ear/persistence";
import {
  InMemoryVectorIndex,
  KnowledgeIndexWorker,
  KnowledgeIngestionService,
  KnowledgeSearchService,
  type VectorIndex,
  type VectorPoint,
  type VectorSearchRequest,
  type VectorSearchResult,
} from "@ear/retrieval";
import { afterEach, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("PostgreSQL Knowledge Outbox", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
  });

  it("连续入库后应立即批量领取全部索引任务", async () => {
    const connection = createDatabaseConnection(databaseUrl!);
    closeCallbacks.push(connection.close);
    const repository = new PostgresKnowledgeRepository(connection.db);
    const ingestion = new KnowledgeIngestionService(repository);
    const worker = new KnowledgeIndexWorker(
      repository,
      new DeterministicEmbeddingProvider(32),
      new InMemoryVectorIndex(),
    );
    const suffix = randomUUID();
    const documents = [];
    for (const [index, title] of ["供应商准入制度", "资金核验制度"].entries()) {
      documents.push(await ingestion.ingest({
        tenantId: `tenant-batch-${suffix}`,
        userId: "admin-batch",
        documentKey: `policy-${index}-${suffix}`,
        version: 1,
        title,
        content: `# ${title}\n连续入库后必须能够立即参与索引。`,
        permissionTags: [],
      }));
    }

    const result = await worker.runOnce(10);

    expect(result.failed).toEqual([]);
    expect(new Set(result.indexed)).toEqual(new Set(documents.map((document) => document.id)));
  });

  it("索引失败后应保留Outbox并在下一轮重试成功", async () => {
    const connection = createDatabaseConnection(databaseUrl!);
    closeCallbacks.push(connection.close);
    const repository = new PostgresKnowledgeRepository(connection.db);
    const embeddings = new DeterministicEmbeddingProvider(32);
    const delegate = new InMemoryVectorIndex();
    const index = new FailOnceVectorIndex(delegate);
    const ingestion = new KnowledgeIngestionService(repository);
    const worker = new KnowledgeIndexWorker(repository, embeddings, index);
    const search = new KnowledgeSearchService(repository, embeddings, delegate);
    const documentKey = `policy-${randomUUID()}`;

    const document = await ingestion.ingest({
      tenantId: "tenant-a",
      userId: "admin-a",
      documentKey,
      version: 1,
      title: "供应商准入制度",
      content: "# 高风险供应商\n存在重大资金异常时必须人工复核。",
      permissionTags: [],
    });
    const first = await worker.runOnce();
    expect(first.failed).toEqual([document.id]);

    const second = await worker.runOnce();
    expect(second.indexed).toEqual([document.id]);
    const results = await search.search({
      tenantId: "tenant-a",
      query: "资金异常怎么处理",
      limit: 3,
    });
    expect(results[0]).toMatchObject({
      documentId: document.id,
      documentVersion: 1,
      section: "高风险供应商",
    });
  });
});

class FailOnceVectorIndex implements VectorIndex {
  private failed = false;

  constructor(private readonly delegate: VectorIndex) {}

  ensureCollection(dimensions: number): Promise<void> {
    return this.delegate.ensureCollection(dimensions);
  }

  async replaceDocument(input: {
    tenantId: string;
    documentKey: string;
    points: VectorPoint[];
  }): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      throw new Error("Injected Qdrant outage");
    }
    await this.delegate.replaceDocument(input);
  }

  search(input: VectorSearchRequest): Promise<VectorSearchResult[]> {
    return this.delegate.search(input);
  }
}
