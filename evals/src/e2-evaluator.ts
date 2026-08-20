import type { RealM2EvaluationReport } from "./real-evaluator.js";
import { runRealM2Evaluation } from "./real-evaluator.js";

export interface MetricDistribution {
  mean: number;
  min: number;
  max: number;
  standardDeviation: number;
}

export interface E2RegressionResult {
  baselineAvailable: boolean;
  baselineGitRevision?: string;
  compatible: boolean;
  passed: boolean;
  deltas: {
    retrievalRecallAt5: number;
    citationAccuracy: number;
    taskSuccessRate: number;
    recoveryPassRate: number;
    p95DurationMsRatio: number;
  };
  issues: string[];
}

export interface E2EvaluationReport {
  schemaVersion: "1.0";
  mode: "real-aggregate";
  generatedAt: string;
  gitRevision: string;
  runCount: number;
  datasets: RealM2EvaluationReport["datasets"];
  sampleSizes: RealM2EvaluationReport["sampleSizes"];
  providers: RealM2EvaluationReport["providers"];
  runs: RealM2EvaluationReport[];
  quality: {
    retrievalRecallAt5: MetricDistribution;
    citationAccuracy: MetricDistribution;
    evidenceValidity: MetricDistribution;
    taskSuccessRate: MetricDistribution;
    recoveryPassRate: MetricDistribution;
    candidateRejectionRate: MetricDistribution;
  };
  latency: {
    p50DurationMs: MetricDistribution;
    p95DurationMs: MetricDistribution;
  };
  security: { tenantLeakage: number; duplicateSideEffects: number };
  usage: { totalTokens: number; estimatedCostCny: number; providerCalls: number };
  regression: E2RegressionResult;
  thresholds: Record<string, boolean>;
  overallPassed: boolean;
  limitations: string[];
}

export async function runE2Evaluation(input: {
  runCount?: number;
  baseline?: E2EvaluationReport;
} = {}): Promise<E2EvaluationReport> {
  const runCount = input.runCount ?? 3;
  if (!Number.isInteger(runCount) || runCount < 1) throw new Error("E2 run count must be a positive integer.");
  const runs: RealM2EvaluationReport[] = [];
  for (let index = 0; index < runCount; index += 1) {
    runs.push(await runRealM2Evaluation({
      datasetVersion: "v2",
      runLabel: `e2-run-${index + 1}-of-${runCount}`,
    }));
  }
  return buildE2EvaluationReport(runs, input.baseline);
}

export function buildE2EvaluationReport(
  runs: RealM2EvaluationReport[],
  baseline?: E2EvaluationReport,
): E2EvaluationReport {
  if (runs.length === 0) throw new Error("E2 aggregate requires at least one real evaluation run.");
  const first = runs[0]!;
  assertCompatibleRuns(runs, first);
  const quality = {
    retrievalRecallAt5: distribution(runs.map((item) => item.retrieval.recallAt5)),
    citationAccuracy: distribution(runs.map((item) => item.risk.citationAccuracy)),
    evidenceValidity: distribution(runs.map((item) => item.risk.evidenceValidity)),
    taskSuccessRate: distribution(runs.map((item) => item.risk.taskSuccessRate)),
    recoveryPassRate: distribution(runs.map((item) => item.recovery.passRate)),
    candidateRejectionRate: distribution(runs.map((item) => item.risk.candidateRejectionRate)),
  };
  const latency = {
    p50DurationMs: distribution(runs.map((item) => item.risk.p50DurationMs)),
    p95DurationMs: distribution(runs.map((item) => item.risk.p95DurationMs)),
  };
  const security = {
    tenantLeakage: sum(runs.map((item) => item.security.tenantLeakage)),
    duplicateSideEffects: sum(runs.map((item) => item.risk.duplicateSideEffects)),
  };
  const regression = compareRegression({ quality, latency }, first, baseline);
  const thresholds = {
    allRunsPassed: runs.every((item) => item.overallPassed),
    retrievalRecallAt5: quality.retrievalRecallAt5.min >= 0.85,
    citationAccuracy: quality.citationAccuracy.min >= 0.9,
    evidenceValidity: quality.evidenceValidity.min === 1,
    recoveryPassRate: quality.recoveryPassRate.min === 1,
    candidateRejectionRate: quality.candidateRejectionRate.max <= 0.1,
    tenantLeakage: security.tenantLeakage === 0,
    duplicateSideEffects: security.duplicateSideEffects === 0,
    taskSuccessVariance: quality.taskSuccessRate.standardDeviation <= 0.05,
    regression: regression.passed,
  };
  return {
    schemaVersion: "1.0",
    mode: "real-aggregate",
    generatedAt: new Date().toISOString(),
    gitRevision: first.gitRevision,
    runCount: runs.length,
    datasets: first.datasets,
    sampleSizes: first.sampleSizes,
    providers: first.providers,
    runs,
    quality,
    latency,
    security,
    usage: {
      totalTokens: sum(runs.map((item) => item.usage.totalTokens)),
      estimatedCostCny: round(sum(runs.map((item) => item.usage.estimatedCostCny)), 6),
      providerCalls: sum(runs.map((item) => item.usage.calls.length)),
    },
    regression,
    thresholds,
    overallPassed: Object.values(thresholds).every(Boolean),
    limitations: [
      "The 30/20/10 dataset meets the minimum acceptance size but remains synthetic and domain-scoped.",
      "Three-run variance measures provider nondeterminism at one point in time; it is not a long-term availability claim.",
      "Cost is estimated from configured rates and must be reconciled with the Bailian billing console.",
    ],
  };
}

function assertCompatibleRuns(runs: RealM2EvaluationReport[], first: RealM2EvaluationReport): void {
  for (const run of runs) {
    if (JSON.stringify(run.datasets) !== JSON.stringify(first.datasets)) {
      throw new Error("E2 runs use different dataset versions.");
    }
    if (JSON.stringify(run.sampleSizes) !== JSON.stringify(first.sampleSizes)) {
      throw new Error("E2 runs use different sample sizes.");
    }
    if (JSON.stringify(run.providers) !== JSON.stringify(first.providers)) {
      throw new Error("E2 runs use different providers.");
    }
  }
}

function compareRegression(
  current: Pick<E2EvaluationReport, "quality" | "latency">,
  first: RealM2EvaluationReport,
  baseline?: E2EvaluationReport,
): E2RegressionResult {
  const compatible = Boolean(
    baseline &&
    JSON.stringify(baseline.datasets) === JSON.stringify(first.datasets) &&
    JSON.stringify(baseline.sampleSizes) === JSON.stringify(first.sampleSizes) &&
    JSON.stringify(baseline.providers) === JSON.stringify(first.providers),
  );
  if (!baseline || !compatible) {
    return {
      baselineAvailable: Boolean(baseline),
      ...(baseline ? { baselineGitRevision: baseline.gitRevision } : {}),
      compatible,
      passed: true,
      deltas: emptyDeltas(),
      issues: [baseline ? "Previous E2 report is not comparable; a new baseline is established." : "No previous E2 report; this run establishes the baseline."],
    };
  }
  const deltas = {
    retrievalRecallAt5: round(current.quality.retrievalRecallAt5.mean - baseline.quality.retrievalRecallAt5.mean, 4),
    citationAccuracy: round(current.quality.citationAccuracy.mean - baseline.quality.citationAccuracy.mean, 4),
    taskSuccessRate: round(current.quality.taskSuccessRate.mean - baseline.quality.taskSuccessRate.mean, 4),
    recoveryPassRate: round(current.quality.recoveryPassRate.mean - baseline.quality.recoveryPassRate.mean, 4),
    p95DurationMsRatio: baseline.latency.p95DurationMs.mean === 0
      ? 0
      : round(current.latency.p95DurationMs.mean / baseline.latency.p95DurationMs.mean - 1, 4),
  };
  const issues: string[] = [];
  if (deltas.retrievalRecallAt5 < -0.02) issues.push("Retrieval Recall@5 regressed by more than 2 percentage points.");
  if (deltas.citationAccuracy < -0.02) issues.push("Citation accuracy regressed by more than 2 percentage points.");
  if (deltas.taskSuccessRate < -0.05) issues.push("Task success rate regressed by more than 5 percentage points.");
  if (deltas.recoveryPassRate < 0) issues.push("Recovery pass rate regressed.");
  if (deltas.p95DurationMsRatio > 0.25) issues.push("P95 latency increased by more than 25 percent.");
  return {
    baselineAvailable: true,
    baselineGitRevision: baseline.gitRevision,
    compatible: true,
    passed: issues.length === 0,
    deltas,
    issues,
  };
}

function emptyDeltas(): E2RegressionResult["deltas"] {
  return {
    retrievalRecallAt5: 0,
    citationAccuracy: 0,
    taskSuccessRate: 0,
    recoveryPassRate: 0,
    p95DurationMsRatio: 0,
  };
}

function distribution(values: number[]): MetricDistribution {
  const mean = sum(values) / values.length;
  const variance = sum(values.map((value) => (value - mean) ** 2)) / values.length;
  return {
    mean: round(mean, 4),
    min: round(Math.min(...values), 4),
    max: round(Math.max(...values), 4),
    standardDeviation: round(Math.sqrt(variance), 4),
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, digits: number): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}
