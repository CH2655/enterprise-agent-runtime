import { hasScope, identityFromJwtClaims } from "@ear/auth";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("JWT可信身份", () => {
  it("应从已验证Claims构造租户身份并去重权限", () => {
    const identity = identityFromJwtClaims(
      {
        sub: "reviewer-1",
        tenant_id: "tenant-a",
        roles: ["risk_reviewer", "risk_reviewer"],
        scopes: ["risk:read", "risk:approve", "risk:approve"],
      },
      "request-1",
    );

    expect(identity).toEqual({
      tenantId: "tenant-a",
      userId: "reviewer-1",
      roles: ["risk_reviewer"],
      scopes: ["risk:read", "risk:approve"],
      requestId: "request-1",
    });
    expect(hasScope(identity, "risk:approve")).toBe(true);
    expect(hasScope(identity, "risk:write")).toBe(false);
  });

  it("应拒绝缺少用户或租户的Claims", () => {
    expect(() => identityFromJwtClaims({ sub: "reviewer-1" }, "request-1")).toThrow(ZodError);
    expect(() => identityFromJwtClaims({ tenant_id: "tenant-a" }, "request-1")).toThrow(ZodError);
  });

  it("应为未声明角色和权限的合法Claims提供空集合", () => {
    expect(
      identityFromJwtClaims(
        { sub: "reader-1", tenant_id: "tenant-a" },
        "request-2",
      ),
    ).toMatchObject({ roles: [], scopes: [] });
  });
});
