import { z } from "zod";

export const AgentIdentitySchema = z.object({
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  roles: z.array(z.string().min(1)).optional(),
  scopes: z.array(z.string().min(1)).optional(),
});

export type AgentIdentity = z.infer<typeof AgentIdentitySchema>;

export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
]);

export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const EvidenceSourceTypeSchema = z.enum([
  "document",
  "knowledge",
  "business_object",
  "tool",
]);

export const EvidenceRecordSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  runId: z.string().min(1),
  category: z.string().min(1),
  sourceType: EvidenceSourceTypeSchema,
  sourceId: z.string().min(1),
  content: z.string().min(1),
  locator: z.string().optional(),
  hash: z.string().optional(),
  collectedAt: z.string().datetime(),
});

export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const RiskFindingSchema = z.object({
  id: z.string().min(1),
  dimension: z.string().min(1),
  level: z.enum(["low", "medium", "high"]),
  claim: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  recommendation: z.string().min(1),
});

export type RiskFinding = z.infer<typeof RiskFindingSchema>;

export const RiskCaseInputSchema = z.object({
  caseId: z.string().min(1),
  projectCode: z.string().min(1),
  supplierCode: z.string().min(1),
});

export type RiskCaseInput = z.infer<typeof RiskCaseInputSchema>;

export const WriteBackResultSchema = z.object({
  taskId: z.string().min(1),
  created: z.boolean(),
});

export type WriteBackResult = z.infer<typeof WriteBackResultSchema>;
