import { runM2Evaluation } from "../../evals/src/evaluator.js";
import { renderMarkdownReport } from "../../evals/src/report.js";
import { describe, expect, it } from "vitest";

describe("M2 E0 evaluation", () => {
  it("应对固定数据集生成可追溯的确定性基线", async () => {
    const report = await runM2Evaluation();

    expect(report.mode).toBe("deterministic");
    expect(report.retrieval.cases).toHaveLength(8);
    expect(report.risk.cases).toHaveLength(6);
    expect(report.security.cases).toHaveLength(3);
    expect(report.retrieval.recallAt5).toBeGreaterThanOrEqual(0.85);
    expect(report.risk.evidenceValidity).toBe(1);
    expect(report.risk.citationAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(report.risk.taskSuccessRate).toBe(1);
    expect(report.security.tenantLeakage).toBe(0);
    expect(report.risk.duplicateSideEffects).toBe(0);
    expect(report.overallPassed).toBe(true);
  });

  it("应覆盖补充Loop、有界失败、非法计划和审批写回", async () => {
    const report = await runM2Evaluation();
    const cases = new Map(report.risk.cases.map((item) => [item.id, item]));

    expect(cases.get("risk-supplemental-loop")).toMatchObject({
      status: "waiting_approval",
      iterations: 2,
      passed: true,
    });
    expect(cases.get("risk-bounded-tool-failure")).toMatchObject({
      status: "waiting_input",
      iterations: 3,
      passed: true,
    });
    expect(cases.get("risk-invalid-plan")).toMatchObject({
      status: "waiting_input",
      iterations: 0,
      passed: true,
    });
    expect(cases.get("risk-approved-writeback")).toMatchObject({
      status: "completed",
      duplicateSideEffects: 0,
      passed: true,
    });
  });

  it("应明确标注确定性报告不能作为真实模型质量结论", async () => {
    const markdown = renderMarkdownReport(await runM2Evaluation());

    expect(markdown).toContain("not a real-model quality claim");
    expect(markdown).toContain("E0 uses deterministic embeddings");
  });
});
