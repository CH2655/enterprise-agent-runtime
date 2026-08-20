import { z } from "zod";

const StableChunkRefSchema = z.object({
  documentKey: z.string().min(1),
  section: z.string().min(1),
});

export const RetrievalDatasetSchema = z.object({
  version: z.string().min(1),
  documents: z.array(z.object({
    tenantId: z.string().min(1),
    userId: z.string().min(1),
    documentKey: z.string().min(1),
    version: z.number().int().positive(),
    title: z.string().min(1),
    content: z.string().min(1),
    permissionTags: z.array(z.string().min(1)),
  })).min(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    query: z.string().min(1),
    permissionTags: z.array(z.string().min(1)),
    relevant: z.array(StableChunkRefSchema).min(1),
  })).min(1),
});

const RiskFixtureSchema = z.object({
  enterpriseRisk: z.object({
    dishonest: z.boolean(),
    legalCaseCount: z.number().int().nonnegative(),
  }),
  bankStatement: z.object({
    abnormalTransactions: z.number().int().nonnegative(),
    cashFlowStable: z.boolean(),
  }),
  failTools: z.array(z.string().min(1)).default([]),
});

export const RiskDatasetSchema = z.object({
  version: z.string().min(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    strategy: z.enum(["one_pass", "supplemental_loop", "invalid_plan"]),
    input: z.object({
      caseId: z.string().min(1),
      projectCode: z.string().min(1),
      supplierCode: z.string().min(1),
    }),
    fixture: RiskFixtureSchema,
    approve: z.boolean().default(false),
    realEligible: z.boolean().default(true),
    realFailToolAttempts: z.record(z.string(), z.number().int().nonnegative()).default({}),
    expected: z.object({
      status: z.enum(["waiting_input", "waiting_approval", "completed"]),
      iterations: z.number().int().nonnegative(),
      findingDimensions: z.array(z.string().min(1)),
      evidenceCategories: z.array(z.string().min(1)),
      requiredEvents: z.array(z.string().min(1)),
      citationSupport: z.record(z.string(), z.array(z.string().min(1))),
    }),
  })).min(1),
});

export const TenantAttackDatasetSchema = z.object({
  version: z.string().min(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    tenantId: z.string().min(1),
    query: z.string().min(1),
    permissionTags: z.array(z.string().min(1)),
    forbiddenTenantIds: z.array(z.string().min(1)),
    forbiddenSections: z.array(z.string().min(1)).default([]),
    forbiddenContent: z.array(z.string().min(1)).default([]),
  })).min(1),
});

export type RetrievalDataset = z.infer<typeof RetrievalDatasetSchema>;
export type RiskDataset = z.infer<typeof RiskDatasetSchema>;
export type RiskEvaluationCase = RiskDataset["cases"][number];
export type TenantAttackDataset = z.infer<typeof TenantAttackDatasetSchema>;
