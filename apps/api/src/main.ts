import { createApp } from "./app.js";
import { createPostgresInfrastructure } from "./infrastructure.js";
import {
  BailianChatCompletionsModelProvider,
  DeterministicEmbeddingProvider,
  OpenAIEmbeddingProvider,
  OpenAIResponsesModelProvider,
} from "@ear/model-provider";
import { QdrantVectorIndex } from "@ear/retrieval";

const authMode = process.env.AUTH_MODE ?? "demo";
const auth = authMode === "jwt"
  ? {
      mode: "jwt" as const,
      secret: requiredEnvironment("JWT_SECRET"),
      issuer: process.env.JWT_ISSUER ?? "enterprise-auth",
      audience: process.env.JWT_AUDIENCE ?? "enterprise-agent-runtime",
    }
  : { mode: "demo" as const };

const infrastructure = process.env.DATABASE_URL
  ? await createPostgresInfrastructure(process.env.DATABASE_URL)
  : undefined;
const modelBaseUrl = process.env.OPENAI_BASE_URL;
const modelWireApi = process.env.MODEL_WIRE_API ?? (
  modelBaseUrl?.includes("maas.aliyuncs.com") || modelBaseUrl?.includes("dashscope.aliyuncs.com")
    ? "chat_completions"
    : "responses"
);
const modelProvider = process.env.OPENAI_API_KEY
  ? modelWireApi === "chat_completions"
    ? new BailianChatCompletionsModelProvider({
        apiKey: process.env.OPENAI_API_KEY,
        model: requiredEnvironment("OPENAI_MODEL"),
        baseUrl: requiredEnvironment("OPENAI_BASE_URL"),
      })
    : new OpenAIResponsesModelProvider({
        apiKey: process.env.OPENAI_API_KEY,
        model: requiredEnvironment("OPENAI_MODEL"),
        ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
      })
  : undefined;
const embeddingDimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 256);
const embeddingProvider = process.env.OPENAI_API_KEY
  ? new OpenAIEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
      dimensions: embeddingDimensions,
      ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
    })
  : new DeterministicEmbeddingProvider(embeddingDimensions);
const vectorIndex = process.env.QDRANT_URL
  ? new QdrantVectorIndex({
      url: process.env.QDRANT_URL,
      collection: process.env.QDRANT_COLLECTION ?? "knowledge_chunks",
      ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
    })
  : undefined;
const runtimeApp = createApp({
  auth,
  infrastructure,
  modelProvider,
  embeddingProvider,
  vectorIndex,
  useKnowledgeSearchTool: true,
  knowledgeIndexIntervalMs: Number(process.env.KNOWLEDGE_INDEX_INTERVAL_MS ?? 2_000),
});
const { app } = runtimeApp;
const port = Number(process.env.PORT ?? 3001);

if (authMode === "demo" && process.env.SEED_DEMO_DATA !== "false") {
  await seedDemoKnowledge(runtimeApp);
}

await app.listen({ host: "127.0.0.1", port });
console.log(`Enterprise Agent Runtime API: http://127.0.0.1:${port}`);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function seedDemoKnowledge(runtime: ReturnType<typeof createApp>): Promise<void> {
  const documents = [
    {
      tenantId: "tenant-a",
      userId: "demo-admin-a",
      documentKey: "supplier-policy",
      version: 1,
      title: "供应商准入与风险复核制度",
      content: [
        "# 高风险供应商",
        "存在失信记录或重大资金异常的供应商必须进入人工复核。",
        "",
        "## 整改要求",
        "复核通过后应创建整改任务，并持续核验异常交易用途。",
      ].join("\n"),
      permissionTags: ["risk_reviewer"],
    },
    {
      tenantId: "tenant-b",
      userId: "demo-admin-b",
      documentKey: "supplier-policy",
      version: 1,
      title: "供应商分级管理办法",
      content: [
        "# 供应商分级",
        "一般信用异常可由业务负责人补充说明后进入准入评估。",
        "",
        "## 资金核验",
        "重大资金异常仍需提交风控负责人复核。",
      ].join("\n"),
      permissionTags: ["risk_reviewer"],
    },
  ];
  for (const document of documents) {
    const existing = await runtime.infrastructure.knowledge.getDocumentVersion(
      document.tenantId,
      document.documentKey,
      document.version,
    );
    if (!existing) await runtime.knowledgeIngestion.ingest(document);
  }
  await runtime.knowledgeWorker.runOnce();
}
