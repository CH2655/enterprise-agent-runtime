import { seedDemoData } from "../../scripts/demo-data.js";
import { describe, expect, it } from "vitest";

describe("固定演示数据", () => {
  it("应首次创建三个场景并完成合同审批", async () => {
    const api = new FakeDemoApi();

    const summary = await seedDemoData("http://runtime.test/api", api.fetch);

    expect(summary).toEqual({
      created: ["tenant-a-risk-review", "tenant-a-contract-completed", "tenant-b-isolation"],
      skipped: [],
      approved: ["tenant-a-contract-completed"],
    });
    expect(api.createCalls).toBe(3);
    expect(api.approveCalls).toBe(1);
  });

  it("应重复执行时复用已有场景且不重复审批", async () => {
    const api = new FakeDemoApi();
    await seedDemoData("http://runtime.test/api", api.fetch);

    const summary = await seedDemoData("http://runtime.test/api", api.fetch);

    expect(summary).toEqual({
      created: [],
      skipped: ["tenant-a-risk-review", "tenant-a-contract-completed", "tenant-b-isolation"],
      approved: [],
    });
    expect(api.createCalls).toBe(3);
    expect(api.approveCalls).toBe(1);
  });
});

class FakeDemoApi {
  createCalls = 0;
  approveCalls = 0;
  private nextId = 1;
  private readonly runs = new Map<string, Array<{ id: string; agentId: string; status: string; input: Record<string, unknown> }>>();

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const tenantId = String(new Headers(init?.headers).get("x-demo-tenant"));
    const tenantRuns = this.runs.get(tenantId) ?? [];
    if (init?.method === "POST" && /\/runs\/[^/]+\/approve$/.test(url.pathname)) {
      this.approveCalls += 1;
      const run = tenantRuns.find((candidate) => url.pathname.endsWith(`/${candidate.id}/approve`));
      if (!run) return json({ message: "not found" }, 404);
      run.status = "completed";
      return json(run);
    }
    if (init?.method === "POST" && url.pathname.endsWith("/runs")) {
      this.createCalls += 1;
      const body = JSON.parse(String(init.body)) as { agentId: string; input: Record<string, unknown> };
      const run = { id: `run-${this.nextId++}`, status: "waiting_approval", ...body };
      tenantRuns.push(run);
      this.runs.set(tenantId, tenantRuns);
      return json(run, 201);
    }
    if (url.pathname.endsWith("/runs")) return json(tenantRuns);
    return json({ message: "unsupported" }, 404);
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
