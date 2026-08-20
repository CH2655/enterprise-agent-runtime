import type { E2EvaluationReport, MetricDistribution } from "./e2-evaluator.js";

export function renderE2MarkdownReport(report: E2EvaluationReport): string {
  return [
    "# M2 E2 Aggregate Evaluation",
    "",
    "> Three-run baseline using real PostgreSQL, Qdrant and Bailian providers.",
    "",
    "## Run Metadata",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Git revision: \`${report.gitRevision}\``,
    `- Runs: ${report.runCount}`,
    `- Model: \`${report.providers.model}\``,
    `- Embedding: \`${report.providers.embedding}\` (${report.providers.embeddingDimensions} dimensions)`,
    `- Datasets: \`${Object.values(report.datasets).join("`, `")}\``,
    `- Sample sizes per run: ${report.sampleSizes.retrieval}/${report.sampleSizes.risk}/${report.sampleSizes.tenantAttacks}`,
    "",
    "## Quality Distribution",
    "",
    "| Metric | Mean | Min | Max | Std Dev | Target |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    distributionRow("Retrieval Recall@5", report.quality.retrievalRecallAt5, ">= 85%"),
    distributionRow("Citation Accuracy", report.quality.citationAccuracy, ">= 90%"),
    distributionRow("Evidence Validity", report.quality.evidenceValidity, "100%"),
    distributionRow("Task Success Rate", report.quality.taskSuccessRate, "recorded"),
    distributionRow("Recovery Pass Rate", report.quality.recoveryPassRate, "100%"),
    "",
    `- Tenant leakage across all runs: ${report.security.tenantLeakage}`,
    `- Duplicate side effects across all runs: ${report.security.duplicateSideEffects}`,
    `- P50 latency mean/min/max: ${duration(report.latency.p50DurationMs)}`,
    `- P95 latency mean/min/max: ${duration(report.latency.p95DurationMs)}`,
    `- Total provider calls: ${report.usage.providerCalls}`,
    `- Total tokens: ${report.usage.totalTokens}`,
    `- Estimated total cost: CNY ${report.usage.estimatedCostCny.toFixed(6)}`,
    "",
    "## Per-Run Result",
    "",
    "| Run | Recall@5 | Citation | Task Success | Recovery | P95 | Result |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.runs.map((run) =>
      `| ${run.runLabel} | ${percentage(run.retrieval.recallAt5)} | ${percentage(run.risk.citationAccuracy)} | ${percentage(run.risk.taskSuccessRate)} | ${percentage(run.recovery.passRate)} | ${run.risk.p95DurationMs} ms | ${run.overallPassed ? "PASS" : "FAIL"} |`,
    ),
    "",
    "## Regression",
    "",
    `- Comparable baseline: ${report.regression.compatible ? "yes" : "no"}`,
    `- Regression gate: ${report.regression.passed ? "PASS" : "FAIL"}`,
    ...report.regression.issues.map((item) => `- ${item}`),
    "",
    `Overall: **${report.overallPassed ? "PASS" : "FAIL"}**`,
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

function distributionRow(name: string, value: MetricDistribution, target: string): string {
  return `| ${name} | ${percentage(value.mean)} | ${percentage(value.min)} | ${percentage(value.max)} | ${percentage(value.standardDeviation)} | ${target} |`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function duration(value: MetricDistribution): string {
  return `${value.mean}/${value.min}/${value.max} ms`;
}
