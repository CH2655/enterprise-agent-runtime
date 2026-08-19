import {
  ToolAuthorizationError,
  ToolApprovalRequiredError,
  ToolIdempotencyKeyRequiredError,
  RuleBasedObjectPermissionPolicy,
  ToolRegistry,
  ToolValidationError,
} from "@ear/tool-registry";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const context = {
  runId: "run-1",
  identity: { tenantId: "tenant-a", userId: "user-1" },
};

describe("ToolRegistry", () => {
  it("应校验工具输入并透传可信租户上下文", async () => {
    const execute = vi.fn(async (input: { code: string }, toolContext: typeof context) => ({
      code: input.code,
      tenantId: toolContext.identity.tenantId,
    }));
    const registry = new ToolRegistry();
    registry.register({
      name: "read_record",
      description: "读取业务对象",
      access: "read",
      inputSchema: z.object({ code: z.string().min(1) }),
      outputSchema: z.object({ code: z.string(), tenantId: z.string() }),
      execute,
    });

    await expect(registry.execute("read_record", { code: "S-1" }, context)).resolves.toEqual({
      code: "S-1",
      tenantId: "tenant-a",
    });
    await expect(registry.execute("read_record", { code: "" }, context)).rejects.toBeInstanceOf(
      ToolValidationError,
    );
  });

  it("应阻止未审批或缺少幂等键的写工具", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "write_record",
      description: "写入业务对象",
      access: "write",
      inputSchema: z.object({ code: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      async execute() {
        return { ok: true };
      },
    });

    await expect(registry.execute("write_record", { code: "S-1" }, context)).rejects.toBeInstanceOf(
      ToolApprovalRequiredError,
    );
    await expect(
      registry.execute("write_record", { code: "S-1" }, context, {
        approval: { approved: true, approvedBy: "user-1" },
      }),
    ).rejects.toBeInstanceOf(ToolIdempotencyKeyRequiredError);
  });

  it("应在执行工具体前拒绝缺少Scope的调用", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry();
    registry.register({
      name: "protected_read",
      description: "读取受保护业务对象",
      access: "read",
      requiredScopes: ["supplier:read"],
      inputSchema: z.object({ code: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute,
    });

    await expect(
      registry.execute("protected_read", { code: "S-1" }, context),
    ).rejects.toBeInstanceOf(ToolAuthorizationError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("应在执行工具体前拒绝无权访问的PaaS业务对象", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const permissions = new RuleBasedObjectPermissionPolicy([
      {
        tenantId: "tenant-a",
        appName: "std",
        metaName: "supplier",
        action: "view",
        objectId: "S-ALLOWED",
      },
    ]);
    const registry = new ToolRegistry(undefined, undefined, permissions);
    registry.register({
      name: "read_supplier",
      description: "读取供应商业务对象",
      access: "read",
      permission: ({ code }) => ({
        appName: "std",
        metaName: "supplier",
        action: "view",
        objectId: code,
      }),
      inputSchema: z.object({ code: z.string() }),
      outputSchema: z.object({ ok: z.boolean() }),
      execute,
    });

    await expect(
      registry.execute("read_supplier", { code: "S-DENIED" }, context),
    ).rejects.toBeInstanceOf(ToolAuthorizationError);
    expect(execute).not.toHaveBeenCalled();

    await expect(
      registry.execute("read_supplier", { code: "S-ALLOWED" }, context),
    ).resolves.toEqual({ ok: true });
  });

  it("应通过幂等键避免重复执行写操作", async () => {
    const execute = vi.fn(async () => ({ taskId: "task-1" }));
    const registry = new ToolRegistry();
    registry.register({
      name: "create_task",
      description: "创建任务",
      access: "write",
      inputSchema: z.object({ caseId: z.string() }),
      outputSchema: z.object({ taskId: z.string() }),
      execute,
    });
    const options = {
      approval: { approved: true as const, approvedBy: "user-1" },
      idempotencyKey: "case-1:create-task",
    };

    const first = await registry.execute("create_task", { caseId: "case-1" }, context, options);
    const second = await registry.execute("create_task", { caseId: "case-1" }, context, options);

    expect(first).toEqual(second);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
