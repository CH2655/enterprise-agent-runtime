import { AgentIdentitySchema } from "@ear/domain";
import { registerPaasObjectTools } from "@ear/paas-metadata";
import {
  InMemoryToolIdempotencyStore,
  RuleBasedObjectPermissionPolicy,
  ToolRegistry,
} from "@ear/tool-registry";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DemoSupplierGateway, demoSupplierMetadata } from "./demo.js";
import { createPaasMcpServer } from "./index.js";

const tenantId = process.env.MCP_TENANT_ID ?? "tenant-a";
const userId = process.env.MCP_USER_ID ?? "mcp-local-user";
const scopes = splitEnv(process.env.MCP_SCOPES, ["supplier:read"]);
const identity = AgentIdentitySchema.parse({ tenantId, userId, scopes });
const registry = new ToolRegistry(
  (record) => console.error(JSON.stringify({ type: "tool.audit", ...record })),
  new InMemoryToolIdempotencyStore(),
  new RuleBasedObjectPermissionPolicy([
    { tenantId, appName: "std", metaName: "Supplier", action: "view" },
    { tenantId, appName: "std", metaName: "Supplier", action: "create" },
    { tenantId, appName: "std", metaName: "Supplier", action: "edit" },
  ]),
);
registerPaasObjectTools(registry, demoSupplierMetadata, new DemoSupplierGateway());

const server = createPaasMcpServer(registry, ({ extra }) => {
  const approvedBy = process.env.MCP_APPROVED_BY;
  const requestIdempotencyKey = extra._meta?.["ear/idempotency-key"];
  const idempotencyKey =
    typeof requestIdempotencyKey === "string"
      ? requestIdempotencyKey
      : process.env.MCP_IDEMPOTENCY_KEY;
  return {
    identity,
    runId: `mcp-${String(extra.requestId)}`,
    options: {
      ...(approvedBy ? { approval: { approved: true, approvedBy } } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
});

await server.connect(new StdioServerTransport());
console.error("Enterprise Agent PaaS MCP Server is running on stdio");

function splitEnv(value: string | undefined, fallback: string[]): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? fallback;
}
