import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runE2Evaluation, type E2EvaluationReport } from "./e2-evaluator.js";
import { renderE2MarkdownReport } from "./e2-report.js";

const reportDirectory = fileURLToPath(new URL("../reports/", import.meta.url));
const jsonPath = `${reportDirectory}/latest.e2.json`;
const baseline = await readPreviousReport(jsonPath);
const runCount = readRunCount();
const report = await runE2Evaluation({ runCount, ...(baseline ? { baseline } : {}) });
await mkdir(reportDirectory, { recursive: true });
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(`${reportDirectory}/latest.e2.md`, renderE2MarkdownReport(report), "utf8"),
]);

console.log(JSON.stringify({
  overallPassed: report.overallPassed,
  runCount: report.runCount,
  sampleSizes: report.sampleSizes,
  retrievalRecallAt5: report.quality.retrievalRecallAt5,
  citationAccuracy: report.quality.citationAccuracy,
  taskSuccessRate: report.quality.taskSuccessRate,
  recoveryPassRate: report.quality.recoveryPassRate,
  candidateRejectionRate: report.quality.candidateRejectionRate,
  p95DurationMs: report.latency.p95DurationMs,
  tenantLeakage: report.security.tenantLeakage,
  duplicateSideEffects: report.security.duplicateSideEffects,
  totalTokens: report.usage.totalTokens,
  estimatedCostCny: report.usage.estimatedCostCny,
  regression: report.regression,
  reports: ["evals/reports/latest.e2.json", "evals/reports/latest.e2.md"],
}, null, 2));

if (!report.overallPassed) process.exitCode = 1;

async function readPreviousReport(path: string): Promise<E2EvaluationReport | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<E2EvaluationReport>;
    return parsed.schemaVersion === "1.0" && parsed.mode === "real-aggregate"
      ? parsed as E2EvaluationReport
      : undefined;
  } catch {
    return undefined;
  }
}

function readRunCount(): number {
  const value = Number(process.env.EVAL_E2_RUNS ?? 3);
  if (!Number.isInteger(value) || value < 1) throw new Error("EVAL_E2_RUNS must be a positive integer.");
  return value;
}
