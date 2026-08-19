import {
  ModelProviderOutputError,
  OpenAIEmbeddingProvider,
  OpenAIResponsesModelProvider,
  ScriptedModelProvider,
} from "@ear/model-provider";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const ResultSchema = z.object({ tools: z.array(z.string()) });

describe("Model Provider", () => {
  it("应校验确定性Provider返回的结构化结果", async () => {
    const provider = new ScriptedModelProvider({
      "risk.plan": () => ({ tools: ["get_project_profile"] }),
    });

    await expect(
      provider.generateStructured({
        task: "risk.plan",
        system: "生成取证计划",
        input: {},
        schemaName: "risk_plan",
        schema: ResultSchema,
      }),
    ).resolves.toEqual({ tools: ["get_project_profile"] });
  });

  it("应拒绝不符合Schema的确定性结果", async () => {
    const provider = new ScriptedModelProvider({
      "risk.plan": () => ({ tools: "unknown" }),
    });

    await expect(
      provider.generateStructured({
        task: "risk.plan",
        system: "生成取证计划",
        input: {},
        schemaName: "risk_plan",
        schema: ResultSchema,
      }),
    ).rejects.toBeInstanceOf(ModelProviderOutputError);
  });

  it("应通过Responses API Structured Outputs请求并解析结果", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"tools":["get_supplier_profile"]}' }],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new OpenAIResponsesModelProvider({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl,
    });

    await expect(
      provider.generateStructured({
        task: "risk.plan",
        system: "生成取证计划",
        input: { missingCategories: ["supplier"] },
        schemaName: "risk_plan",
        schema: ResultSchema,
      }),
    ).resolves.toEqual({ tools: ["get_supplier_profile"] });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.text.format).toMatchObject({
      type: "json_schema",
      name: "risk_plan",
      strict: true,
    });
    expect(request.text.format.schema.additionalProperties).toBe(false);
  });

  it("应将模型拒绝转换成明确错误", async () => {
    const provider = new OpenAIResponsesModelProvider({
      apiKey: "test-key",
      model: "test-model",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              { type: "message", content: [{ type: "refusal", refusal: "request refused" }] },
            ],
          }),
          { status: 200 },
        ),
    });

    await expect(
      provider.generateStructured({
        task: "risk.plan",
        system: "生成取证计划",
        input: {},
        schemaName: "risk_plan",
        schema: ResultSchema,
      }),
    ).rejects.toThrow("request refused");
  });

  it("应批量请求Embedding并按响应index恢复输入顺序", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          data: [
            { index: 1, embedding: [0, 1, 0] },
            { index: 0, embedding: [1, 0, 0] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new OpenAIEmbeddingProvider({
      apiKey: "test-key",
      model: "text-embedding-3-small",
      dimensions: 3,
      fetchImpl,
    });

    await expect(provider.embed(["制度", "供应商"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      model: "text-embedding-3-small",
      input: ["制度", "供应商"],
      dimensions: 3,
      encoding_format: "float",
    });
  });
});
