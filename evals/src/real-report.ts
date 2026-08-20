import type { RealM2EvaluationReport } from "./real-evaluator.js";

export function renderRealMarkdownReport(report: RealM2EvaluationReport): string {
  return [
    "# M2 E1 Real Evaluation",
    "",
    "> Small-sample baseline using real PostgreSQL, Qdrant and Bailian providers.",
    "",
    "## Run Metadata",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Git revision: \`${report.gitRevision}\``,
    `- Model: \`${report.providers.model}\``,
    `- Embedding: \`${report.providers.embedding}\` (${report.providers.embeddingDimensions} dimensions)`,
    `- Datasets: \`${Object.values(report.datasets).join("`, `")}\``,
    "",
    "## Quality Summary",
    "",
    "| Metric | Result | Target | Status |",
    "| --- | ---: | ---: | --- |",
    metric("Retrieval Recall@5", percentage(report.retrieval.recallAt5), ">= 85%", report.thresholds.retrievalRecallAt5),
    metric("Citation Accuracy", percentage(report.risk.citationAccuracy), ">= 90%", report.thresholds.citationAccuracy),
    metric("Evidence Validity", percentage(report.risk.evidenceValidity), "100%", report.thresholds.evidenceValidity),
    metric("Task Success Rate", percentage(report.risk.taskSuccessRate), "baseline", report.risk.taskSuccessRate === 1),
    metric("Tenant Leakage", String(report.security.tenantLeakage), "0", report.thresholds.tenantLeakage),
    metric("Duplicate Side Effects", String(report.risk.duplicateSideEffects), "0", report.thresholds.duplicateSideEffects),
    "",
    `Overall: **${report.overallPassed ? "PASS" : "FAIL"}**`,
    "",
    "## Latency And Cost",
    "",
    `- Agent P50: ${report.risk.p50DurationMs} ms`,
    `- Agent P95: ${report.risk.p95DurationMs} ms`,
    `- Model input tokens: ${report.usage.inputTokens}`,
    `- Model output tokens: ${report.usage.outputTokens}`,
    `- Embedding tokens: ${report.usage.embeddingTokens}`,
    `- Estimated cost: CNY ${report.usage.estimatedCostCny.toFixed(6)}`,
    "",
    "## Risk Agent Cases",
    "",
    "| Case | Status | Iterations | Duration | Result | Issues |",
    "| --- | --- | ---: | ---: | --- | --- |",
    ...report.risk.cases.map((item) =>
      `| ${item.id} | ${item.status} | ${item.iterations} | ${item.durationMs} ms | ${item.passed ? "PASS" : "FAIL"} | ${item.issues.join("; ") || "-"} |`,
    ),
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

function metric(name: string, result: string, target: string, passed: unknown): string {
  return `| ${name} | ${result} | ${target} | ${passed ? "PASS" : "FAIL"} |`;
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

