import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPaasMcpServer } from "@ear/paas-mcp-server";
import {
  registerPaasObjectTools,
  type PaasObjectGateway,
  type PaasObjectMetadata,
} from "@ear/paas-metadata";
import {
  RuleBasedObjectPermissionPolicy,
  ToolRegistry,
  type ToolAuditRecord,
} from "@ear/tool-registry";
import { describe, expect, it, vi } from "vitest";

describe("PaaS MCP Server", () => {
  it("应通过MCP和内部调用复用相同Registry、审批与幂等记录", async () => {
    const audit: ToolAuditRecord[] = [];
    const create = vi.fn(async ({ values }: { values: Record<string, unknown> }) => ({
      code: "SUP-NEW",
      ...values,
    }));
    const gateway: PaasObjectGateway = {
      get: vi.fn(async () => ({})),
      create,
      update: vi.fn(async () => ({})),
    };
    const registry = new ToolRegistry(
      (record) => {
        audit.push(record);
      },
      undefined,
      new RuleBasedObjectPermissionPolicy([
        { appName: "std", metaName: "Supplier", action: "create" },
      ]),
    );
    registerPaasObjectTools(registry, createOnlyMetadata, gateway);
    const identity = {
      tenantId: "tenant-a",
      userId: "approver-1",
      scopes: ["supplier:write"],
    };
    const options = {
      approval: { approved: true as const, approvedBy: "approver-1" },
      idempotencyKey: "supplier:create:request-1",
    };
    const input = { values: { name: "示例供应商" } };

    const server = createPaasMcpServer(registry, () => ({
      runId: "run-2",
      identity,
      options,
    }));
    const client = new Client({ name: "m3-contract-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toEqual(["paas_supplier_create"]);

      const mcpResult = await client.callTool({
        name: "paas_supplier_create",
        arguments: input,
      });
      const internalResult = await registry.execute(
        "paas_supplier_create",
        input,
        { runId: "run-1", identity },
        options,
      );
      expect(mcpResult.structuredContent).toEqual(internalResult);
      expect(create).toHaveBeenCalledTimes(1);
      expect(
        audit.map(({ status, toolName, tenantId, access }) => ({
          status,
          toolName,
          tenantId,
          access,
        })),
      ).toEqual([
        {
          status: "started",
          toolName: "paas_supplier_create",
          tenantId: "tenant-a",
          access: "write",
        },
        {
          status: "completed",
          toolName: "paas_supplier_create",
          tenantId: "tenant-a",
          access: "write",
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

const createOnlyMetadata = {
  source: "rn-paas-snapshot",
  version: "supplier-v1",
  appName: "std",
  metaName: "Supplier",
  label: "供应商档案",
  actions: {
    create: { permissionAction: "create", requiredScopes: ["supplier:write"] },
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
      permissions: { read: true, create: true, update: true },
      policy: { read: "plain", write: "allow" },
    },
  ],
} satisfies PaasObjectMetadata;
