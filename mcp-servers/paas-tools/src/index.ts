import type { AgentIdentity } from "@ear/domain";
import type {
  ExposedToolDefinition,
  ToolExecutionOptions,
  ToolRegistry,
} from "@ear/tool-registry";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";

export interface McpRegistryInvocation {
  identity: AgentIdentity;
  runId: string;
  options?: ToolExecutionOptions;
}

export interface McpToolContextRequest {
  tool: ExposedToolDefinition;
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
}

export type McpToolContextResolver = (
  request: McpToolContextRequest,
) => McpRegistryInvocation | Promise<McpRegistryInvocation>;

export function createPaasMcpServer(
  registry: ToolRegistry,
  resolveContext: McpToolContextResolver,
): McpServer {
  const server = new McpServer(
    { name: "enterprise-agent-paas-tools", version: "0.1.0" },
    { instructions: "PaaS tools are governed by the Enterprise Agent Runtime Tool Registry." },
  );

  for (const tool of registry.listExposed("mcp")) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.access === "read",
          destructiveHint: false,
          idempotentHint: tool.access === "write",
        },
      },
      async (args, extra) => {
        const invocation = await resolveContext({ tool, extra });
        const output = await registry.execute(
          tool.name,
          args,
          { identity: invocation.identity, runId: invocation.runId },
          invocation.options,
        );
        const structuredContent = asStructuredContent(output);
        return {
          content: [{ type: "text", text: JSON.stringify(output) }],
          ...(structuredContent ? { structuredContent } : {}),
        };
      },
    );
  }

  return server;
}

function asStructuredContent(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
