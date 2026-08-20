import {
  compilePaasObjectTools,
  PaasMetadataCompilationError,
  paasToolName,
  registerPaasObjectTools,
  type PaasObjectGateway,
  type PaasObjectMetadata,
} from "@ear/paas-metadata";
import {
  RuleBasedObjectPermissionPolicy,
  ToolRegistry,
  ToolValidationError,
} from "@ear/tool-registry";
import { describe, expect, it, vi } from "vitest";

const metadata = {
  source: "rn-paas-snapshot",
  version: "supplier-meta-v7",
  appName: "std",
  metaName: "Supplier",
  label: "供应商档案",
  actions: {
    get: { permissionAction: "view", requiredScopes: ["supplier:read"] },
    create: { permissionAction: "create", requiredScopes: ["supplier:write"] },
    update: { permissionAction: "edit", requiredScopes: ["supplier:write"] },
  },
  fields: [
    field("code", "编码", "AutoCode", {
      required: 1,
      readOnly: 1,
      permissions: { read: true, create: false, update: false },
    }),
    field("name", "名称", "Text", { required: 1, maxLength: 40 }),
    field("registeredCapital", "注册资本", "Currency", { required: 1 }),
    field("bankAccount", "银行账号", "Text", {
      policy: { read: "masked", write: "deny" },
    }),
    field("internalMemo", "内部备注", "Text", {
      policy: { read: "deny", write: "deny" },
    }),
    field("riskScore", "风险分", "Aggregation", { readOnly: 1 }),
  ],
} satisfies PaasObjectMetadata;

const readContext = {
  runId: "run-meta-1",
  identity: {
    tenantId: "tenant-a",
    userId: "user-1",
    scopes: ["supplier:read", "supplier:write"],
  },
};

describe("PaaS元数据工具编译器", () => {
  it("应从对象元数据生成读写工具及字段约束", () => {
    const gateway = gatewayMock();
    const tools = compilePaasObjectTools(metadata, gateway);

    expect(tools.map((tool) => tool.name)).toEqual([
      "paas_supplier_get",
      "paas_supplier_create",
      "paas_supplier_update",
    ]);
    const create = tools.find((tool) => tool.name === paasToolName("Supplier", "create"))!;
    expect(create.inputSchema.safeParse({ values: { name: "示例供应商" } }).success).toBe(false);
    expect(
      create.inputSchema.safeParse({
        values: { name: "示例供应商", registeredCapital: 2_000_000 },
      }).success,
    ).toBe(true);
    expect(
      create.inputSchema.safeParse({
        values: {
          name: "示例供应商",
          registeredCapital: 2_000_000,
          code: "SYSTEM-MANAGED",
        },
      }).success,
    ).toBe(false);
  });

  it("应在读取结果中脱敏受限字段并删除禁止字段", async () => {
    const gateway = gatewayMock();
    gateway.get = vi.fn(async () => ({
      code: "SUP-1",
      name: "示例供应商",
      registeredCapital: 2_000_000,
      bankAccount: "6222020200123456",
      internalMemo: "仅风控负责人可见",
      riskScore: 82,
    }));
    const registry = permittedRegistry();
    registerPaasObjectTools(registry, metadata, gateway);

    await expect(
      registry.execute("paas_supplier_get", { objectId: "SUP-1" }, readContext),
    ).resolves.toEqual({
      metadataVersion: "supplier-meta-v7",
      record: {
        code: "SUP-1",
        name: "示例供应商",
        registeredCapital: 2_000_000,
        bankAccount: "****3456",
        riskScore: 82,
      },
    });
    expect(gateway.get).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: "SUP-1",
        select: ["code", "name", "registeredCapital", "bankAccount", "riskScore"],
        context: expect.objectContaining({ identity: readContext.identity, metadata }),
      }),
    );
  });

  it("应在调用业务网关前拒绝只读或敏感字段写入", async () => {
    const gateway = gatewayMock();
    const registry = permittedRegistry();
    registerPaasObjectTools(registry, metadata, gateway);
    const options = {
      approval: { approved: true as const, approvedBy: "approver-1" },
      idempotencyKey: "supplier-1:update",
    };

    await expect(
      registry.execute(
        "paas_supplier_update",
        { objectId: "SUP-1", patch: { bankAccount: "new-account" } },
        readContext,
        options,
      ),
    ).rejects.toBeInstanceOf(ToolValidationError);
    expect(gateway.update).not.toHaveBeenCalled();
  });

  it("应在编译前拒绝重复字段的外部元数据快照", () => {
    expect(() =>
      compilePaasObjectTools(
        { ...metadata, fields: [...metadata.fields, metadata.fields[0]!] },
        gatewayMock(),
      ),
    ).toThrow(PaasMetadataCompilationError);
  });
});

function field(
  name: string,
  label: string,
  type: PaasObjectMetadata["fields"][number]["type"],
  overrides: Partial<PaasObjectMetadata["fields"][number]> = {},
): PaasObjectMetadata["fields"][number] {
  return {
    name,
    label,
    type,
    permissions: { read: true, create: true, update: true },
    policy: { read: "plain", write: "allow" },
    ...overrides,
  };
}

function gatewayMock(): PaasObjectGateway {
  return {
    get: vi.fn(async () => ({})),
    create: vi.fn(async ({ values }) => ({ code: "SUP-NEW", ...values })),
    update: vi.fn(async ({ objectId, patch }) => ({ code: objectId, ...patch })),
  };
}

function permittedRegistry(): ToolRegistry {
  return new ToolRegistry(
    undefined,
    undefined,
    new RuleBasedObjectPermissionPolicy([
      { appName: "std", metaName: "Supplier", action: "*" },
    ]),
  );
}
