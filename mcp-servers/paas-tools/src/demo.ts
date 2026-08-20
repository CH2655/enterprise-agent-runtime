import type { PaasObjectGateway, PaasObjectMetadata } from "@ear/paas-metadata";

export const demoSupplierMetadata = {
  source: "rn-paas-snapshot",
  version: "supplier-demo-v1",
  appName: "std",
  metaName: "Supplier",
  label: "供应商档案",
  actions: {
    get: { permissionAction: "view", requiredScopes: ["supplier:read"] },
    create: { permissionAction: "create", requiredScopes: ["supplier:write"] },
    update: { permissionAction: "edit", requiredScopes: ["supplier:write"] },
  },
  fields: [
    {
      name: "code",
      label: "编码",
      type: "AutoCode",
      readOnly: 1,
      permissions: { read: true, create: false, update: false },
      policy: { read: "plain", write: "deny" },
    },
    {
      name: "name",
      label: "名称",
      type: "Text",
      required: 1,
      maxLength: 80,
      permissions: { read: true, create: true, update: true },
      policy: { read: "plain", write: "allow" },
    },
    {
      name: "registeredCapital",
      label: "注册资本",
      type: "Currency",
      required: 1,
      permissions: { read: true, create: true, update: true },
      policy: { read: "plain", write: "allow" },
    },
    {
      name: "bankAccount",
      label: "银行账号",
      type: "Text",
      permissions: { read: true, create: false, update: false },
      policy: { read: "masked", write: "deny" },
    },
    {
      name: "internalMemo",
      label: "内部备注",
      type: "Text",
      permissions: { read: true, create: false, update: false },
      policy: { read: "deny", write: "deny" },
    },
  ],
} satisfies PaasObjectMetadata;

export class DemoSupplierGateway implements PaasObjectGateway {
  private readonly records = new Map<string, Record<string, unknown>>([
    [
      "tenant-a:SUP-001",
      {
        code: "SUP-001",
        name: "示例供应商",
        registeredCapital: 2_000_000,
        bankAccount: "6222020200123456",
        internalMemo: "该字段不会进入 Agent Tool 输出",
      },
    ],
  ]);

  async get({ objectId, context }: Parameters<PaasObjectGateway["get"]>[0]) {
    const record = this.records.get(key(context.identity.tenantId, objectId));
    if (!record) throw new Error(`Supplier not found: ${objectId}`);
    return { ...record };
  }

  async create({ values, context }: Parameters<PaasObjectGateway["create"]>[0]) {
    const code = `SUP-${String(this.records.size + 1).padStart(3, "0")}`;
    const record = { code, ...values };
    this.records.set(key(context.identity.tenantId, code), record);
    return { ...record };
  }

  async update({ objectId, patch, context }: Parameters<PaasObjectGateway["update"]>[0]) {
    const recordKey = key(context.identity.tenantId, objectId);
    const current = this.records.get(recordKey);
    if (!current) throw new Error(`Supplier not found: ${objectId}`);
    const updated = { ...current, ...patch, code: objectId };
    this.records.set(recordKey, updated);
    return { ...updated };
  }
}

function key(tenantId: string, objectId: string): string {
  return `${tenantId}:${objectId}`;
}
