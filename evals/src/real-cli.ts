import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runRealM2Evaluation } from "./real-evaluator.js";
import { renderRealMarkdownReport } from "./real-report.js";

const datasetVersion = process.env.EVAL_DATASET_VERSION === "v2" ? "v2" : "v1";
const report = await runRealM2Evaluation({ datasetVersion });
const reportDirectory = fileURLToPath(new URL("../reports/", import.meta.url));
await mkdir(reportDirectory, { recursive: true });
await Promise.all([
  writeFile(`${reportDirectory}/latest.real.json`, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(`${reportDirectory}/latest.real.md`, renderRealMarkdownReport(report), "utf8"),
]);

console.log(JSON.stringify({
  overallPassed: report.overallPassed,
  retrievalRecallAt5: report.retrieval.recallAt5,
  citationAccuracy: report.risk.citationAccuracy,
  evidenceValidity: report.risk.evidenceValidity,
  taskSuccessRate: report.risk.taskSuccessRate,
  tenantLeakage: report.security.tenantLeakage,
  recoveryPassRate: report.recovery.passRate,
  p50DurationMs: report.risk.p50DurationMs,
  p95DurationMs: report.risk.p95DurationMs,
  totalTokens: report.usage.totalTokens,
  estimatedCostCny: report.usage.estimatedCostCny,
  reports: ["evals/reports/latest.real.json", "evals/reports/latest.real.md"],
}, null, 2));

if (!report.overallPassed) process.exitCode = 1;
