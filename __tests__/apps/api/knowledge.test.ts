import { createApp } from "../../../apps/api/src/app.js";
import { afterEach, describe, expect, it } from "vitest";

describe("Knowledge API", () => {
  const apps: Array<ReturnType<typeof createApp>["app"]> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("应从可信身份写入并按租户隔离检索", async () => {
    const { app, knowledgeWorker } = createApp();
    apps.push(app);
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/api/knowledge/documents",
      headers: { "x-demo-tenant": "tenant-a", "x-demo-user": "admin-a" },
      payload: {
        documentKey: "supplier-policy",
        version: 1,
        title: "供应商准入制度",
        content: "# 高风险供应商\n存在失信记录时必须人工复核。",
      },
    });
    expect(created.statusCode).toBe(202);
    expect(created.json().document).toMatchObject({
      tenantId: "tenant-a",
      documentKey: "supplier-policy",
      status: "active",
    });
    expect(created.json().indexing).toEqual({ status: "queued" });
    await knowledgeWorker.runOnce();

    const own = await app.inject({
      method: "GET",
      url: "/api/knowledge/search?query=失信记录怎么处理",
      headers: { "x-demo-tenant": "tenant-a", "x-demo-user": "reviewer-a" },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()[0]).toMatchObject({ tenantId: "tenant-a", documentVersion: 1 });

    const other = await app.inject({
      method: "GET",
      url: "/api/knowledge/search?query=失信记录怎么处理",
      headers: { "x-demo-tenant": "tenant-b", "x-demo-user": "reviewer-b" },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toEqual([]);
  });
});
