import { createApp } from "../../../apps/api/src/app.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("Run List API", () => {
  const apps: Array<ReturnType<typeof createApp>["app"]> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("应只返回可信身份所属租户的任务摘要并支持状态筛选", async () => {
    const { app } = createApp();
    apps.push(app);
    await app.ready();
    await createRun(app, "tenant-a", "case-a");
    await createRun(app, "tenant-b", "case-b");

    const response = await app.inject({
      method: "GET",
      url: "/api/runs?status=waiting_approval&limit=20",
      headers: demoHeaders("tenant-a"),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(1);
    expect(response.json()[0]).toMatchObject({
      status: "waiting_approval",
      input: { caseId: "case-a" },
      summary: { coverage: 1, evidenceCount: 5, findingCount: 2 },
    });
    expect(response.json()[0]).not.toHaveProperty("state");
    expect(JSON.stringify(response.json())).not.toContain("case-b");
  });

  it("异步模式应立即返回running并在后台推进到审批状态", async () => {
    const { app, runtime } = createApp();
    apps.push(app);
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/runs?mode=async",
      headers: demoHeaders("tenant-a"),
      payload: {
        agentId: "risk-agent",
        input: { caseId: "case-async", projectCode: "P-1", supplierCode: "S-1" },
      },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("running");
    await vi.waitFor(async () => {
      const run = await runtime.getRun(response.json().id, {
        tenantId: "tenant-a",
        userId: "tenant-a-reviewer",
      });
      expect(run.status).toBe("waiting_approval");
    });
  });

  it("合同Agent应复用通用Run、Evidence、审批和事件协议", async () => {
    const { app } = createApp();
    apps.push(app);
    await app.ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: demoHeaders("tenant-a"),
      payload: {
        agentId: "contract-agent",
        input: { contractId: "CON-001", supplierCode: "SUP-001" },
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      agentId: "contract-agent",
      status: "waiting_approval",
      state: { evidence: expect.any(Array), findings: expect.any(Array) },
    });
    const approved = await app.inject({
      method: "POST",
      url: `/api/runs/${created.json().id}/approve`,
      headers: demoHeaders("tenant-a"),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: "completed",
      state: {
        writeBack: { taskId: "contract-review-CON-001", created: true },
      },
    });
    const events = await app.inject({
      method: "GET",
      url: `/api/runs/${created.json().id}/events?after=0`,
      headers: demoHeaders("tenant-a"),
    });
    expect(events.json().map((item: { type: string }) => item.type)).toEqual(
      expect.arrayContaining(["evidence.added", "approval.required", "run.completed"]),
    );
  });
});

async function createRun(
  app: ReturnType<typeof createApp>["app"],
  tenantId: string,
  caseId: string,
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/runs",
    headers: demoHeaders(tenantId),
    payload: {
      agentId: "risk-agent",
      input: { caseId, projectCode: `P-${caseId}`, supplierCode: `S-${caseId}` },
    },
  });
  expect(response.statusCode).toBe(201);
}

function demoHeaders(tenantId: string) {
  return { "x-demo-tenant": tenantId, "x-demo-user": `${tenantId}-reviewer` };
}
