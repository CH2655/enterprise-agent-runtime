import type { ToolDefinition, ToolRegistry } from "@ear/tool-registry";
import { z } from "zod";

const codeInput = z.object({ code: z.string().min(1) });

const tools: ToolDefinition<any, any>[] = [
  {
    name: "get_project_profile",
    description: "读取当前租户的项目基本信息",
    access: "read",
    permission: ({ code }) => ({
      appName: "std",
      metaName: "project",
      action: "view",
      objectId: code,
    }),
    inputSchema: codeInput,
    outputSchema: z.object({ code: z.string(), name: z.string(), budget: z.number() }),
    async execute({ code }, context) {
      return {
        code,
        name: `${context.identity.tenantId}示例项目`,
        budget: 12_000_000,
      };
    },
  },
  {
    name: "get_supplier_profile",
    description: "读取当前租户可访问的供应商档案",
    access: "read",
    permission: ({ code }) => ({
      appName: "std",
      metaName: "supplier",
      action: "view",
      objectId: code,
    }),
    inputSchema: codeInput,
    outputSchema: z.object({ code: z.string(), name: z.string(), registeredCapital: z.number() }),
    async execute({ code }, context) {
      return {
        code,
        name: `${context.identity.tenantId}示例供应商`,
        registeredCapital: 2_000_000,
      };
    },
  },
  {
    name: "get_enterprise_risks",
    description: "查询供应商的企业风险和失信记录",
    access: "read",
    permission: ({ code }) => ({
      appName: "std",
      metaName: "supplier",
      action: "view",
      objectId: code,
    }),
    inputSchema: codeInput,
    outputSchema: z.object({ dishonest: z.boolean(), legalCaseCount: z.number() }),
    async execute() {
      return { dishonest: true, legalCaseCount: 2 };
    },
  },
  {
    name: "get_bank_statement_summary",
    description: "读取脱敏后的银行流水风险摘要",
    access: "read",
    permission: ({ code }) => ({
      appName: "std",
      metaName: "supplier",
      action: "view_finance_summary",
      objectId: code,
    }),
    inputSchema: codeInput,
    outputSchema: z.object({ abnormalTransactions: z.number(), cashFlowStable: z.boolean() }),
    async execute() {
      return { abnormalTransactions: 3, cashFlowStable: false };
    },
  },
  {
    name: "search_internal_policy",
    description: "检索当前租户的供应商准入制度",
    access: "read",
    permission: () => ({
      appName: "knowledge",
      metaName: "supplier_policy",
      action: "view",
    }),
    inputSchema: z.object({ query: z.string().min(1) }),
    outputSchema: z.object({ documentId: z.string(), section: z.string(), content: z.string() }),
    async execute(_input, context) {
      return {
        documentId: `${context.identity.tenantId}-supplier-policy`,
        section: "3.2 高风险供应商",
        content: "存在失信记录或重大资金异常的供应商必须进入人工复核。",
      };
    },
  },
  {
    name: "create_rectification_task",
    description: "为已确认的风险项创建整改任务",
    access: "write",
    requiredScopes: ["risk:write"],
    permission: ({ caseId }) => ({
      appName: "std",
      metaName: "rectification_task",
      action: "create",
      objectId: caseId,
    }),
    inputSchema: z.object({ caseId: z.string().min(1), findingIds: z.array(z.string()).min(1) }),
    outputSchema: z.object({ taskId: z.string(), created: z.boolean() }),
    async execute({ caseId }) {
      return { taskId: `rectification-${caseId}`, created: true };
    },
  },
];

export function registerMockPaasTools(registry: ToolRegistry): void {
  for (const tool of tools) registry.register(tool);
}
