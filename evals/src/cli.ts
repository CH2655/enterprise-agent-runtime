import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runM2Evaluation } from "./evaluator.js";
import { renderMarkdownReport } from "./report.js";

const mode = readArgument("--mode") ?? "deterministic";
if (mode !== "deterministic") {
  throw new Error(`E0 only supports deterministic mode. Received: ${mode}`);
}

const report = await runM2Evaluation();
const reportDirectory = fileURLToPath(new URL("../reports/", import.meta.url));
await mkdir(reportDirectory, { recursive: true });
await Promise.all([
  writeFile(
    `${reportDirectory}/latest.deterministic.json`,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  ),
  writeFile(
    `${reportDirectory}/latest.deterministic.md`,
    renderMarkdownReport(report),
    "utf8",
  ),
]);

console.log(JSON.stringify({
  overallPassed: report.overallPassed,
  retrievalRecallAt5: report.retrieval.recallAt5,
  citationAccuracy: report.risk.citationAccuracy,
  evidenceValidity: report.risk.evidenceValidity,
  taskSuccessRate: report.risk.taskSuccessRate,
  tenantLeakage: report.security.tenantLeakage,
  reports: [
    "evals/reports/latest.deterministic.json",
    "evals/reports/latest.deterministic.md",
  ],
}, null, 2));

if (!report.overallPassed) process.exitCode = 1;

function readArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

