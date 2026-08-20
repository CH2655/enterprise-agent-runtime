import {
  BailianChatCompletionsModelProvider,
  OpenAIEmbeddingProvider,
} from "@ear/model-provider";
import { z } from "zod";

const apiKey = requiredEnvironment("OPENAI_API_KEY");
const baseUrl = requiredEnvironment("OPENAI_BASE_URL");
const model = requiredEnvironment("OPENAI_MODEL");
const embeddingModel = requiredEnvironment("OPENAI_EMBEDDING_MODEL");
const dimensions = Number(requiredEnvironment("EMBEDDING_DIMENSIONS"));
if (!Number.isInteger(dimensions) || dimensions < 1) {
  throw new Error("EMBEDDING_DIMENSIONS must be a positive integer.");
}

const embeddingStartedAt = performance.now();
const [vector] = await new OpenAIEmbeddingProvider({
  apiKey,
  baseUrl,
  model: embeddingModel,
  dimensions,
}).embed(["供应商存在失信记录时必须进入人工复核。"]);
const embeddingDurationMs = Math.round(performance.now() - embeddingStartedAt);

const outputSchema = z.object({
  decision: z.enum(["manual_review", "pass"]),
  reason: z.string().min(1),
});
const modelStartedAt = performance.now();
const output = await new BailianChatCompletionsModelProvider({ apiKey, baseUrl, model })
  .generateStructured({
    task: "bailian.smoke",
    system: "你是接口冒烟测试助手。请严格按照给定 JSON Schema 输出，不要调用任何工具。",
    input: { supplierRisk: "存在失信记录" },
    schemaName: "bailian_smoke_result",
    schema: outputSchema,
  });
const modelDurationMs = Math.round(performance.now() - modelStartedAt);

console.log(JSON.stringify({
  ok: true,
  model,
  embeddingModel,
  embeddingDimensions: vector?.length,
  embeddingDurationMs,
  structuredOutputDurationMs: modelDurationMs,
  structuredOutputValid: outputSchema.safeParse(output).success,
}, null, 2));

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
