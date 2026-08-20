import { createHash, randomUUID } from "node:crypto";
import type { EmbeddingProvider } from "@ear/model-provider";

export interface KnowledgeDocument {
  id: string;
  tenantId: string;
  documentKey: string;
  version: number;
  title: string;
  contentHash: string;
  status: "active" | "archived";
  permissionTags: string[];
  createdBy: string;
  createdAt: string;
  indexedAt?: string;
}

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  tenantId: string;
  documentKey: string;
  documentVersion: number;
  ordinal: number;
  section: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
  permissionTags: string[];
}

export interface ParsedKnowledgeChunk {
  ordinal: number;
  section: string;
  startLine: number;
  endLine: number;
  content: string;
  contentHash: string;
}

export interface KnowledgeOutboxRecord {
  id: string;
  tenantId: string;
  documentId: string;
  status: "pending" | "processing" | "failed" | "completed";
  attempts: number;
  error?: string;
}

export interface IngestKnowledgeInput {
  tenantId: string;
  userId: string;
  documentKey: string;
  version: number;
  title: string;
  content: string;
  permissionTags: string[];
}

export interface KnowledgeRepository {
  saveDocumentVersion(
    input: IngestKnowledgeInput,
    chunks: ParsedKnowledgeChunk[],
  ): Promise<KnowledgeDocument>;
  getDocumentVersion(
    tenantId: string,
    documentKey: string,
    version: number,
  ): Promise<KnowledgeDocument | undefined>;
  getDocument(documentId: string, tenantId: string): Promise<KnowledgeDocument | undefined>;
  getChunksForDocument(documentId: string, tenantId: string): Promise<KnowledgeChunk[]>;
  getActiveChunksByIds(tenantId: string, chunkIds: string[]): Promise<KnowledgeChunk[]>;
  claimIndexJobs(limit: number): Promise<KnowledgeOutboxRecord[]>;
  completeIndexJob(jobId: string, documentId: string, indexed?: boolean): Promise<void>;
  failIndexJob(jobId: string, error: string): Promise<void>;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  tenantId: string;
  documentId: string;
  documentKey: string;
  documentVersion: number;
  chunkId: string;
  permissionTags: string[];
}

export interface VectorSearchRequest {
  tenantId: string;
  vector: number[];
  limit: number;
  permissionTags?: string[];
}

export interface VectorSearchResult {
  chunkId: string;
  score: number;
}

export interface VectorIndex {
  ensureCollection(dimensions: number): Promise<void>;
  replaceDocument(input: {
    tenantId: string;
    documentKey: string;
    points: VectorPoint[];
  }): Promise<void>;
  search(input: VectorSearchRequest): Promise<VectorSearchResult[]>;
}

export interface KnowledgeSearchResult extends KnowledgeChunk {
  chunkId: string;
  score: number;
  locator: string;
}

export class KnowledgeIngestionService {
  constructor(private readonly repository: KnowledgeRepository) {}

  async ingest(input: IngestKnowledgeInput): Promise<KnowledgeDocument> {
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw new Error("Document version must be a positive integer.");
    }
    const chunks = splitMarkdownIntoChunks(input.content);
    if (chunks.length === 0) throw new Error("Document content produced no chunks.");
    return this.repository.saveDocumentVersion(input, chunks);
  }
}

export class KnowledgeIndexWorker {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly index: VectorIndex,
  ) {}

  async runOnce(limit = 10): Promise<{ indexed: string[]; failed: string[]; skipped: string[] }> {
    const jobs = await this.repository.claimIndexJobs(limit);
    const indexed: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    let collectionReady = false;
    for (const job of jobs) {
      try {
        const document = await this.repository.getDocument(job.documentId, job.tenantId);
        if (!document) throw new Error(`Unknown knowledge document: ${job.documentId}`);
        if (document.status !== "active") {
          await this.repository.completeIndexJob(job.id, job.documentId, false);
          skipped.push(job.documentId);
          continue;
        }
        if (!collectionReady) {
          await this.index.ensureCollection(this.embeddings.dimensions);
          collectionReady = true;
        }
        const chunks = await this.repository.getChunksForDocument(job.documentId, job.tenantId);
        if (chunks.length === 0) throw new Error(`Document has no chunks: ${job.documentId}`);
        const vectors = await this.embeddings.embed(chunks.map((chunk) => chunk.content));
        await this.index.replaceDocument({
          tenantId: job.tenantId,
          documentKey: chunks[0]!.documentKey,
          points: chunks.map((chunk, index) => ({
            id: chunk.id,
            vector: vectors[index]!,
            tenantId: chunk.tenantId,
            documentId: chunk.documentId,
            documentKey: chunk.documentKey,
            documentVersion: chunk.documentVersion,
            chunkId: chunk.id,
            permissionTags: chunk.permissionTags,
          })),
        });
        await this.repository.completeIndexJob(job.id, job.documentId);
        indexed.push(job.documentId);
      } catch (error) {
        await this.repository.failIndexJob(
          job.id,
          error instanceof Error ? error.message : String(error),
        );
        failed.push(job.documentId);
      }
    }
    return { indexed, failed, skipped };
  }
}

export class KnowledgeSearchService {
  constructor(
    private readonly repository: KnowledgeRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly index: VectorIndex,
  ) {}

  async search(input: {
    tenantId: string;
    query: string;
    limit: number;
    permissionTags?: string[];
  }): Promise<KnowledgeSearchResult[]> {
    const [vector] = await this.embeddings.embed([input.query]);
    if (!vector) return [];
    const hits = await this.index.search({
      tenantId: input.tenantId,
      vector,
      limit: Math.max(input.limit * 4, input.limit),
      permissionTags: input.permissionTags,
    });
    const chunks = await this.repository.getActiveChunksByIds(
      input.tenantId,
      hits.map((hit) => hit.chunkId),
    );
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const allowedTags = new Set(input.permissionTags ?? []);
    return hits.flatMap((hit) => {
      const chunk = chunksById.get(hit.chunkId);
      const authorized = chunk && (
        chunk.permissionTags.length === 0 ||
        chunk.permissionTags.some((tag) => allowedTags.has(tag))
      );
      return chunk && authorized
        ? [{
            ...chunk,
            chunkId: chunk.id,
            score: hit.score,
            locator: JSON.stringify({
              documentVersion: chunk.documentVersion,
              chunkId: chunk.id,
              section: chunk.section,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
            }),
          }]
        : [];
    }).slice(0, input.limit);
  }
}

export class InMemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly documents = new Map<string, KnowledgeDocument>();
  private readonly chunks = new Map<string, KnowledgeChunk>();
  private readonly jobs = new Map<string, KnowledgeOutboxRecord>();

  async saveDocumentVersion(
    input: IngestKnowledgeInput,
    parsedChunks: ParsedKnowledgeChunk[],
  ): Promise<KnowledgeDocument> {
    const existing = [...this.documents.values()].find(
      (document) => document.tenantId === input.tenantId &&
        document.documentKey === input.documentKey && document.version === input.version,
    );
    if (existing) throw new Error("Document version already exists.");
    for (const document of this.documents.values()) {
      if (document.tenantId === input.tenantId && document.documentKey === input.documentKey) {
        document.status = "archived";
      }
    }
    const document: KnowledgeDocument = {
      id: randomUUID(),
      tenantId: input.tenantId,
      documentKey: input.documentKey,
      version: input.version,
      title: input.title,
      contentHash: sha256(input.content),
      status: "active",
      permissionTags: input.permissionTags,
      createdBy: input.userId,
      createdAt: new Date().toISOString(),
    };
    this.documents.set(document.id, document);
    for (const chunk of parsedChunks) {
      const id = randomUUID();
      this.chunks.set(id, {
        ...chunk,
        id,
        documentId: document.id,
        tenantId: document.tenantId,
        documentKey: document.documentKey,
        documentVersion: document.version,
        permissionTags: document.permissionTags,
      });
    }
    const job: KnowledgeOutboxRecord = {
      id: randomUUID(),
      tenantId: input.tenantId,
      documentId: document.id,
      status: "pending",
      attempts: 0,
    };
    this.jobs.set(job.id, job);
    return document;
  }

  async getDocumentVersion(tenantId: string, documentKey: string, version: number) {
    return [...this.documents.values()].find(
      (document) => document.tenantId === tenantId &&
        document.documentKey === documentKey && document.version === version,
    );
  }

  async getDocument(documentId: string, tenantId: string) {
    const document = this.documents.get(documentId);
    return document?.tenantId === tenantId ? document : undefined;
  }

  async getChunksForDocument(documentId: string, tenantId: string) {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.documentId === documentId && chunk.tenantId === tenantId)
      .sort((left, right) => left.ordinal - right.ordinal);
  }

  async getActiveChunksByIds(tenantId: string, chunkIds: string[]) {
    return chunkIds.flatMap((id) => {
      const chunk = this.chunks.get(id);
      const document = chunk ? this.documents.get(chunk.documentId) : undefined;
      return chunk && chunk.tenantId === tenantId && document?.status === "active" ? [chunk] : [];
    });
  }

  async claimIndexJobs(limit: number) {
    const jobs = [...this.jobs.values()]
      .filter((job) => job.status === "pending" || job.status === "failed")
      .slice(0, limit);
    for (const job of jobs) {
      job.status = "processing";
      job.attempts += 1;
      job.error = undefined;
    }
    return jobs.map((job) => ({ ...job }));
  }

  async completeIndexJob(jobId: string, documentId: string, indexed = true) {
    const job = this.jobs.get(jobId);
    const document = this.documents.get(documentId);
    if (!job || !document) throw new Error("Unknown indexing job.");
    job.status = "completed";
    if (indexed) document.indexedAt = new Date().toISOString();
  }

  async failIndexJob(jobId: string, error: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("Unknown indexing job.");
    job.status = "failed";
    job.error = error;
  }
}

export class InMemoryVectorIndex implements VectorIndex {
  private dimensions?: number;
  private readonly points = new Map<string, VectorPoint>();

  async ensureCollection(dimensions: number): Promise<void> {
    if (this.dimensions && this.dimensions !== dimensions) {
      throw new Error("Vector dimensions do not match the existing collection.");
    }
    this.dimensions = dimensions;
  }

  async replaceDocument(input: {
    tenantId: string;
    documentKey: string;
    points: VectorPoint[];
  }): Promise<void> {
    for (const [id, point] of this.points) {
      if (point.tenantId === input.tenantId && point.documentKey === input.documentKey) {
        this.points.delete(id);
      }
    }
    for (const point of input.points) this.points.set(point.id, point);
  }

  async search(input: VectorSearchRequest): Promise<VectorSearchResult[]> {
    return [...this.points.values()]
      .filter((point) =>
        point.tenantId === input.tenantId && hasPermission(point.permissionTags, input.permissionTags),
      )
      .map((point) => ({ chunkId: point.chunkId, score: cosine(input.vector, point.vector) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, input.limit);
  }
}

export interface QdrantVectorIndexOptions {
  url: string;
  collection: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class QdrantVectorIndex implements VectorIndex {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: QdrantVectorIndexOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.url.replace(/\/$/, "");
  }

  async ensureCollection(dimensions: number): Promise<void> {
    const current = await this.request(`/collections/${this.options.collection}`, { method: "GET" }, [404]);
    if (current.status !== 404) {
      const body = await current.json() as {
        result?: { config?: { params?: { vectors?: { size?: number } } } };
      };
      const currentDimensions = body.result?.config?.params?.vectors?.size;
      if (currentDimensions !== undefined && currentDimensions !== dimensions) {
        throw new Error(
          `Qdrant collection dimensions mismatch: expected ${dimensions}, received ${currentDimensions}.`,
        );
      }
      await this.ensurePayloadIndexes();
      return;
    }
    await this.request(`/collections/${this.options.collection}`, {
      method: "PUT",
      body: JSON.stringify({ vectors: { size: dimensions, distance: "Cosine" } }),
    });
    await this.ensurePayloadIndexes();
  }

  async replaceDocument(input: {
    tenantId: string;
    documentKey: string;
    points: VectorPoint[];
  }): Promise<void> {
    const filter = {
      must: [
        { key: "tenant_id", match: { value: input.tenantId } },
        { key: "document_key", match: { value: input.documentKey } },
      ],
    };
    await this.request(`/collections/${this.options.collection}/points/delete?wait=true`, {
      method: "POST",
      body: JSON.stringify({ filter }),
    });
    await this.request(`/collections/${this.options.collection}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({
        points: input.points.map((point) => ({
          id: point.id,
          vector: point.vector,
          payload: {
            tenant_id: point.tenantId,
            document_id: point.documentId,
            document_key: point.documentKey,
            document_version: point.documentVersion,
            chunk_id: point.chunkId,
            permission_tags: point.permissionTags,
          },
        })),
      }),
    });
  }

  async search(input: VectorSearchRequest): Promise<VectorSearchResult[]> {
    const response = await this.request(
      `/collections/${this.options.collection}/points/query`,
      {
        method: "POST",
        body: JSON.stringify({
          query: input.vector,
          filter: {
            must: [{ key: "tenant_id", match: { value: input.tenantId } }],
            should: [
              { is_empty: { key: "permission_tags" } },
              ...((input.permissionTags?.length ?? 0) > 0
                ? [{ key: "permission_tags", match: { any: input.permissionTags } }]
                : []),
            ],
          },
          limit: input.limit,
          with_payload: ["chunk_id"],
          with_vector: false,
        }),
      },
    );
    const body = await response.json() as {
      result?: { points?: Array<{ id?: string | number; score?: number; payload?: { chunk_id?: string } }> };
    };
    return (body.result?.points ?? []).map((point) => ({
      chunkId: point.payload?.chunk_id ?? String(point.id),
      score: point.score ?? 0,
    }));
  }

  private async request(path: string, init: RequestInit, allowedStatuses: number[] = []) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(this.options.apiKey ? { "api-key": this.options.apiKey } : {}),
        ...init.headers,
      },
    });
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      throw new Error(`Qdrant request failed (${response.status}): ${path}`);
    }
    return response;
  }

  private async ensurePayloadIndexes(): Promise<void> {
    await this.request(`/collections/${this.options.collection}/index?wait=true`, {
      method: "PUT",
      body: JSON.stringify({
        field_name: "tenant_id",
        field_schema: { type: "keyword", is_tenant: true },
      }),
    });
    await this.request(`/collections/${this.options.collection}/index?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ field_name: "document_key", field_schema: "keyword" }),
    });
    await this.request(`/collections/${this.options.collection}/index?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ field_name: "permission_tags", field_schema: "keyword" }),
    });
  }
}

export function splitMarkdownIntoChunks(content: string, maxCharacters = 1_200): ParsedKnowledgeChunk[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const sections: Array<{ section: string; startLine: number; lines: string[] }> = [];
  let current = { section: "Document", startLine: 1, lines: [] as string[] };
  lines.forEach((line, index) => {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current.lines.some((item) => item.trim())) sections.push(current);
      current = { section: heading[1]!, startLine: index + 1, lines: [line] };
    } else {
      current.lines.push(line);
    }
  });
  if (current.lines.some((item) => item.trim())) sections.push(current);

  const chunks: ParsedKnowledgeChunk[] = [];
  for (const section of sections) {
    let segment: string[] = [];
    let segmentStart = section.startLine;
    section.lines.forEach((line, index) => {
      const candidate = [...segment, line].join("\n");
      if (segment.length > 0 && candidate.length > maxCharacters) {
        chunks.push(parsedChunk(chunks.length, section.section, segmentStart, segment));
        segment = [line];
        segmentStart = section.startLine + index;
      } else {
        segment.push(line);
      }
    });
    if (segment.some((line) => line.trim())) {
      chunks.push(parsedChunk(chunks.length, section.section, segmentStart, segment));
    }
  }
  return chunks;
}

function parsedChunk(
  ordinal: number,
  section: string,
  startLine: number,
  lines: string[],
): ParsedKnowledgeChunk {
  let firstContentLine = 0;
  let lastContentLine = lines.length - 1;
  while (firstContentLine <= lastContentLine && !lines[firstContentLine]?.trim()) {
    firstContentLine += 1;
  }
  while (lastContentLine >= firstContentLine && !lines[lastContentLine]?.trim()) {
    lastContentLine -= 1;
  }
  const contentLines = lines.slice(firstContentLine, lastContentLine + 1);
  const content = contentLines.join("\n");
  return {
    ordinal,
    section,
    startLine: startLine + firstContentLine,
    endLine: startLine + lastContentLine,
    content,
    contentHash: sha256(content),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function hasPermission(required: string[], allowed: string[] | undefined): boolean {
  if (required.length === 0) return true;
  const tags = new Set(allowed ?? []);
  return required.some((tag) => tags.has(tag));
}
