import { createApp } from "./app.js";
import { createPostgresInfrastructure } from "./infrastructure.js";
import {
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
const modelProvider = process.env.OPENAI_API_KEY
  ? new OpenAIResponsesModelProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: requiredEnvironment("OPENAI_MODEL"),
      ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
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
const { app } = createApp({
  auth,
  infrastructure,
  modelProvider,
  embeddingProvider,
  vectorIndex,
  useKnowledgeSearchTool: true,
  knowledgeIndexIntervalMs: Number(process.env.KNOWLEDGE_INDEX_INTERVAL_MS ?? 2_000),
});
const port = Number(process.env.PORT ?? 3001);

await app.listen({ host: "127.0.0.1", port });
console.log(`Enterprise Agent Runtime API: http://127.0.0.1:${port}`);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
