import { createApp } from "../../../apps/api/src/app.js";
import { afterEach, describe, expect, it } from "vitest";

const secret = "local-test-secret-that-is-long-enough-for-hmac";
const auth = {
  mode: "jwt" as const,
  secret,
  issuer: "enterprise-auth",
  audience: "enterprise-agent-runtime",
};

describe("Agent API JWT认证", () => {
  const apps: Array<ReturnType<typeof createApp>["app"]> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("应使用已验证Token中的租户身份创建Run", async () => {
    const { app } = createApp({ auth });
    apps.push(app);
    await app.ready();
    const token = app.jwt.sign(
      {
        sub: "reviewer-1",
        tenant_id: "tenant-a",
        roles: ["risk_reviewer"],
        scopes: ["risk:read"],
      },
      { iss: auth.issuer, aud: auth.audience, expiresIn: "5m" },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        agentId: "risk-agent",
        input: { caseId: "case-1", projectCode: "P-1", supplierCode: "S-1" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      tenantId: "tenant-a",
      userId: "reviewer-1",
      status: "waiting_approval",
    });
  });

  it("应拒绝错误签发方的Token", async () => {
    const { app } = createApp({ auth });
    apps.push(app);
    await app.ready();
    const token = app.jwt.sign(
      { sub: "reviewer-1", tenant_id: "tenant-a" },
      { iss: "unknown-issuer", aud: auth.audience, expiresIn: "5m" },
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        agentId: "risk-agent",
        input: { caseId: "case-1", projectCode: "P-1", supplierCode: "S-1" },
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it("应阻止另一个租户读取已创建的Run", async () => {
    const { app } = createApp({ auth });
    apps.push(app);
    await app.ready();
    const tokenA = app.jwt.sign(
      { sub: "reviewer-1", tenant_id: "tenant-a" },
      { iss: auth.issuer, aud: auth.audience, expiresIn: "5m" },
    );
    const tokenB = app.jwt.sign(
      { sub: "reviewer-2", tenant_id: "tenant-b" },
      { iss: auth.issuer, aud: auth.audience, expiresIn: "5m" },
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        agentId: "risk-agent",
        input: { caseId: "case-1", projectCode: "P-1", supplierCode: "S-1" },
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/runs/${created.json().id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).not.toHaveProperty("state");

    const transitions = await app.inject({
      method: "GET",
      url: `/api/runs/${created.json().id}/transitions`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(transitions.statusCode).toBe(403);
    expect(transitions.json()).not.toHaveProperty("actorId");
  });

  it("应阻止缺少审批Scope的用户批准Run", async () => {
    const { app } = createApp({ auth });
    apps.push(app);
    await app.ready();
    const token = app.jwt.sign(
      { sub: "reader-1", tenant_id: "tenant-a", scopes: ["risk:read"] },
      { iss: auth.issuer, aud: auth.audience, expiresIn: "5m" },
    );
    const created = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        agentId: "risk-agent",
        input: { caseId: "case-scope", projectCode: "P-1", supplierCode: "S-1" },
      },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${created.json().id}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).not.toHaveProperty("state");
  });
});
