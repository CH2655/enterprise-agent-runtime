import { z } from "zod";

export interface StructuredModelRequest<TOutput> {
  task: string;
  system: string;
  input: unknown;
  schemaName: string;
  schema: z.ZodType<TOutput>;
}

export interface ModelProvider {
  generateStructured<TOutput>(
    request: StructuredModelRequest<TOutput>,
  ): Promise<TOutput>;
}

export interface ScriptedModelContext<TOutput>
  extends StructuredModelRequest<TOutput> {
  callIndex: number;
}

export type ScriptedModelHandler = (
  context: ScriptedModelContext<unknown>,
) => unknown | Promise<unknown>;

export class ModelProviderRequestError extends Error {}
export class ModelProviderOutputError extends Error {}
export class ModelProviderRefusalError extends Error {}

export interface EmbeddingProvider {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  constructor(readonly dimensions = 64) {
    if (dimensions < 8) throw new Error("Embedding dimensions must be at least 8.");
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => deterministicEmbedding(text, this.dimensions));
  }
}

export interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: OpenAIEmbeddingProviderOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new Error("Embedding dimensions must be a positive integer.");
    }
    this.dimensions = options.dimensions;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (texts.some((text) => text.trim().length === 0)) {
      throw new ModelProviderRequestError("Embedding input cannot be empty.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.options.model,
          input: texts,
          dimensions: this.dimensions,
          encoding_format: "float",
        }),
      });
      const body = await readJsonResponse(response);
      if (!response.ok) {
        throw new ModelProviderRequestError(
          `OpenAI Embeddings request failed (${response.status}): ${errorMessage(body)}`,
        );
      }
      const data = (body as { data?: Array<{ index?: number; embedding?: unknown }> }).data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new ModelProviderOutputError("OpenAI Embeddings returned an unexpected item count.");
      }
      return [...data]
        .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
        .map((item) => {
          if (!Array.isArray(item.embedding) ||
              item.embedding.length !== this.dimensions ||
              item.embedding.some((value) => typeof value !== "number")) {
            throw new ModelProviderOutputError("OpenAI Embeddings returned an invalid vector.");
          }
          return item.embedding as number[];
        });
    } catch (error) {
      if (error instanceof ModelProviderRequestError ||
          error instanceof ModelProviderOutputError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelProviderRequestError(`OpenAI Embeddings request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ScriptedModelProvider implements ModelProvider {
  private readonly callsByTask = new Map<string, number>();

  constructor(private readonly handlers: Record<string, ScriptedModelHandler>) {}

  async generateStructured<TOutput>(
    request: StructuredModelRequest<TOutput>,
  ): Promise<TOutput> {
    const handler = this.handlers[request.task];
    if (!handler) {
      throw new ModelProviderRequestError(`No scripted handler for task: ${request.task}`);
    }
    const callIndex = this.callsByTask.get(request.task) ?? 0;
    this.callsByTask.set(request.task, callIndex + 1);
    const raw = await handler({ ...request, callIndex } as ScriptedModelContext<unknown>);
    return parseModelOutput(request.task, request.schema, raw);
  }
}

export interface OpenAIResponsesModelProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAIResponsesModelProvider implements ModelProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAIResponsesModelProviderOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateStructured<TOutput>(
    request: StructuredModelRequest<TOutput>,
  ): Promise<TOutput> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.options.model,
          input: [
            { role: "system", content: request.system },
            { role: "user", content: JSON.stringify(request.input) },
          ],
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName,
              strict: true,
              schema: z.toJSONSchema(request.schema),
            },
          },
        }),
      });
      const body = await readJsonResponse(response);
      if (!response.ok) {
        throw new ModelProviderRequestError(
          `OpenAI Responses request failed (${response.status}): ${errorMessage(body)}`,
        );
      }
      const output = responseOutput(body);
      let raw: unknown;
      try {
        raw = JSON.parse(output);
      } catch {
        throw new ModelProviderOutputError(
          `Responses API returned invalid JSON for ${request.task}.`,
        );
      }
      return parseModelOutput(request.task, request.schema, raw);
    } catch (error) {
      if (error instanceof ModelProviderRequestError ||
          error instanceof ModelProviderOutputError ||
          error instanceof ModelProviderRefusalError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelProviderRequestError(`OpenAI Responses request failed: ${message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function parseModelOutput<TOutput>(
  task: string,
  schema: z.ZodType<TOutput>,
  raw: unknown,
): TOutput {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ModelProviderOutputError(
      `Invalid structured output for ${task}: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ModelProviderRequestError(
      `OpenAI API returned non-JSON content (${response.status}).`,
    );
  }
}

function responseOutput(body: unknown): string {
  const envelope = body as {
    status?: string;
    incomplete_details?: { reason?: string };
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; refusal?: string }>;
    }>;
  };
  let outputText: string | undefined;
  for (const item of envelope.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "refusal") {
        throw new ModelProviderRefusalError(content.refusal ?? "Model refused the request.");
      }
      if (content.type === "output_text" && content.text) outputText = content.text;
    }
  }
  if (envelope.status === "incomplete") {
    throw new ModelProviderOutputError(
      `Structured output was incomplete: ${envelope.incomplete_details?.reason ?? "unknown"}`,
    );
  }
  if (outputText) return outputText;
  throw new ModelProviderOutputError("Responses API returned no output_text content.");
}

function errorMessage(body: unknown): string {
  const message = (body as { error?: { message?: unknown } })?.error?.message;
  return typeof message === "string" ? message : "unknown error";
}

function deterministicEmbedding(text: string, dimensions: number): number[] {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const characters = [...normalized];
  const tokens = [
    ...characters.filter((value) => value.trim().length > 0),
    ...characters.slice(0, -1).map((value, index) => `${value}${characters[index + 1]}`),
  ];
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of tokens) {
    const hash = hashToken(token);
    const index = hash % dimensions;
    vector[index] = (vector[index] ?? 0) + (hash & 1 ? 1 : -1);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

function hashToken(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
