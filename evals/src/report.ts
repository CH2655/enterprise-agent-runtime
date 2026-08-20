import type { M2EvaluationReport } from "./evaluator.js";

export function renderMarkdownReport(report: M2EvaluationReport): string {
  const thresholdRows = [
    ["Retrieval Recall@5", percentage(report.retrieval.recallAt5), ">= 85%", report.thresholds.retrievalRecallAt5],
    ["Citation Accuracy", percentage(report.risk.citationAccuracy), ">= 90%", report.thresholds.citationAccuracy],
    ["Evidence Validity", percentage(report.risk.evidenceValidity), "100%", report.thresholds.evidenceValidity],
    ["Tenant Leakage", String(report.security.tenantLeakage), "0", report.thresholds.tenantLeakage],
    ["Duplicate Side Effects", String(report.risk.duplicateSideEffects), "0", report.thresholds.duplicateSideEffects],
    ["Task Success Rate", percentage(report.risk.taskSuccessRate), "100% (E0)", report.risk.taskSuccessRate === 1],
  ];
  return [
    "# M2 E0 Deterministic Evaluation",
    "",
    "> This report validates the evaluation harness. It is not a real-model quality claim.",
    "",
    "## Run Metadata",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Git revision: \`${report.gitRevision}\``,
    `- Mode: \`${report.mode}\``,
    `- Datasets: \`${Object.values(report.datasets).join("`, `")}\``,
    "",
    "## Summary",
    "",
    "| Metric | Result | Target | Status |",
    "| --- | ---: | ---: | --- |",
    ...thresholdRows.map(([metric, result, target, passed]) =>
      `| ${metric} | ${result} | ${target} | ${passed ? "PASS" : "FAIL"} |`,
    ),
    "",
    `Overall: **${report.overallPassed ? "PASS" : "FAIL"}**`,
    "",
    "## Retrieval Cases",
    "",
    "| Case | Recall@5 | Relevant Hits | Status |",
    "| --- | ---: | ---: | --- |",
    ...report.retrieval.cases.map((item) =>
      `| ${item.id} | ${percentage(item.recallAt5)} | ${item.retrievedRelevant}/${item.relevant} | ${item.passed ? "PASS" : "FAIL"} |`,
    ),
    "",
    "## Risk Agent Cases",
    "",
    "| Case | Status | Iterations | Duration | Result |",
    "| --- | --- | ---: | ---: | --- |",
    ...report.risk.cases.map((item) =>
      `| ${item.id} | ${item.status} | ${item.iterations} | ${item.durationMs} ms | ${item.passed ? "PASS" : "FAIL"} |`,
    ),
    "",
    "## Tenant Attack Cases",
    "",
    "| Case | Leaks | Status |",
    "| --- | ---: | --- |",
    ...report.security.cases.map((item) => `| ${item.id} | ${item.leaks} | ${item.passed ? "PASS" : "FAIL"} |`),
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

function percentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

