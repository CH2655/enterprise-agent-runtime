import { buildE2EvaluationReport } from "../../evals/src/e2-evaluator.js";
import type { RealM2EvaluationReport } from "../../evals/src/real-evaluator.js";
import { describe, expect, it } from "vitest";

describe("M2 E2 aggregate evaluation", () => {
  it("应聚合三轮质量分布、成本和首次基线", () => {
    const report = buildE2EvaluationReport([
      realRun("run-1", { taskSuccessRate: 1, p95DurationMs: 100, totalTokens: 1_000 }),
      realRun("run-2", { taskSuccessRate: 0.95, p95DurationMs: 110, totalTokens: 1_100 }),
      realRun("run-3", { taskSuccessRate: 0.9, p95DurationMs: 120, totalTokens: 1_200 }),
    ]);

    expect(report.runCount).toBe(3);
    expect(report.quality.taskSuccessRate).toEqual({
      mean: 0.95,
      min: 0.9,
      max: 1,
      standardDeviation: 0.0408,
    });
    expect(report.latency.p95DurationMs.mean).toBe(110);
    expect(report.usage.totalTokens).toBe(3_300);
    expect(report.regression).toMatchObject({
      baselineAvailable: false,
      compatible: false,
      passed: true,
    });
  });

  it("应拒绝质量下降或P95增长超过门限的兼容版本", () => {
    const baseline = buildE2EvaluationReport([
      realRun("baseline-1", { p95DurationMs: 100 }),
      realRun("baseline-2", { p95DurationMs: 100 }),
      realRun("baseline-3", { p95DurationMs: 100 }),
    ]);
    const report = buildE2EvaluationReport([
      realRun("current-1", { retrievalRecallAt5: 0.95, p95DurationMs: 140 }),
      realRun("current-2", { retrievalRecallAt5: 0.95, p95DurationMs: 140 }),
      realRun("current-3", { retrievalRecallAt5: 0.95, p95DurationMs: 140 }),
    ], baseline);

    expect(report.regression).toMatchObject({
      baselineAvailable: true,
      compatible: true,
      passed: false,
      deltas: {
        retrievalRecallAt5: -0.05,
        p95DurationMsRatio: 0.4,
      },
    });
    expect(report.regression.issues).toHaveLength(2);
    expect(report.overallPassed).toBe(false);
  });
});

function realRun(
  runLabel: string,
  overrides: {
    retrievalRecallAt5?: number;
    taskSuccessRate?: number;
    p95DurationMs?: number;
    totalTokens?: number;
  } = {},
): RealM2EvaluationReport {
  const totalTokens = overrides.totalTokens ?? 1_000;
  return {
    schemaVersion: "1.1",
    mode: "real",
    runLabel,
    generatedAt: "2026-08-20T00:00:00.000Z",
    gitRevision: "test-revision",
    providers: {
      model: "test-model",
      embedding: "test-embedding",
      embeddingDimensions: 256,
      database: "postgresql",
      vectorIndex: "qdrant",
    },
    datasets: {
      retrieval: "retrieval.v2",
      risk: "risk-cases.v2",
      tenantAttacks: "tenant-attacks.v2",
    },
    sampleSizes: { retrieval: 30, risk: 20, tenantAttacks: 10 },
    retrieval: { cases: [], recallAt5: overrides.retrievalRecallAt5 ?? 1 },
    risk: {
      cases: [],
      taskSuccessRate: overrides.taskSuccessRate ?? 1,
      evidenceValidity: 1,
      citationAccuracy: 1,
      candidateRejectionRate: 0,
      duplicateSideEffects: 0,
      p50DurationMs: 80,
      p95DurationMs: overrides.p95DurationMs ?? 100,
    },
    security: { cases: [], tenantLeakage: 0 },
    recovery: { cases: [], passRate: 1 },
    usage: {
      calls: [],
      inputTokens: totalTokens,
      outputTokens: 0,
      embeddingTokens: 0,
      totalTokens,
      estimatedCostCny: totalTokens / 1_000,
      ratesCnyPerMillion: { modelInput: 12, modelOutput: 36, embeddingInput: 0.5 },
    },
    thresholds: {},
    overallPassed: true,
    limitations: [],
  };
}
