# 评测结果与简历指标溯源

## 1. 评测分层

| 层级 | 环境 | 目的 | 能否作为简历质量指标 |
| --- | --- | --- | --- |
| E0 | 确定性 Embedding、脚本模型、内存设施 | 验证评测计算和业务分支覆盖 | 否 |
| E1 | 百炼、PostgreSQL、Qdrant，小样本 | 冒烟和发现真实集成问题 | 只能作为过程说明 |
| E2 | 百炼、PostgreSQL、Qdrant，30/20/10，连续三轮 | 固化验收规模基线和回归门禁 | 可以，必须带数据边界 |

## 2. E2 基线

- 绑定代码：`9e8d1ee`
- 模型：`qwen3.7-max`
- Embedding：`text-embedding-v4`，256 维
- 数据集：`retrieval.v2`、`risk-cases.v2`、`tenant-attacks.v2`
- 每轮样本：30 个检索问题、20 个风险案件、10 个攻击样例
- 运行次数：3

| 指标 | 三轮结果 | 简历可用表述 |
| --- | ---: | --- |
| Retrieval Recall@5 | mean/min/max 100% | 在限定 30 题合成制度集三轮 Recall@5 为 100% |
| Citation Accuracy | mean/min/max 100% | Finding 引用正确率由 78.38% 回归到 100% |
| Evidence Validity | 100% | 所有 Finding 均引用已登记 Evidence |
| Task Success Rate | 100% | 限定 20 案例合成集三轮任务成功率 100% |
| Recovery Pass Rate | 100% | 故障注入恢复场景全部通过 |
| Tenant Leakage | 0 | 三轮 30 个攻击样例无跨租户命中 |
| Duplicate Side Effects | 0 | 受测重试与并发场景无重复写入 |
| Agent P50 | 均值 5.01s | 可描述为评测环境基线，不是 SLA |
| Agent P95 | 均值 7.11s | 可描述为评测环境基线，不是 SLA |
| Token/成本 | 121306 Token / CNY 1.750917 | 按配置单价估算，非账单金额 |

完整原始报告：[`evals/reports/latest.e2.md`](../evals/reports/latest.e2.md) 和 [`latest.e2.json`](../evals/reports/latest.e2.json)。

## 3. 一次关键回归

首次 E2 基线 `2ebcac2` 中，模型把制度条件误当作案件事实，导致引用准确率 78.38%、任务成功率 75%。修复包括：

1. Prompt 明确区分“制度规范”与“案件事实”。
2. 增加结构化业务事实守卫，不允许制度 Evidence 单独证明案件发生。
3. 增加候选 Finding 拒绝遥测和同版本回归门禁。

相同数据集回归后，引用准确率提升 21.62 个百分点，任务成功率提升 25 个百分点，P95 均值下降 4.12%。这一过程比单纯展示最终 100% 更能证明评测体系产生了工程价值。

## 4. 禁止扩大的结论

- 数据为合成且领域限定，不能称为真实客户生产准确率。
- 三轮方差只代表一次评测窗口，不能称为长期稳定性或可用性 SLA。
- 成本按配置价格估算，不能替代百炼账单。
- Qdrant 检索通过评测，不代表任意企业文档都能达到相同 Recall。
- 恢复与幂等覆盖约定故障点，不代表任意分布式系统实现 exactly-once。

## 5. 指标到证据映射

| 简历主张 | 自动化或报告证据 |
| --- | --- |
| 受约束动态 Loop | `__tests__/agents/risk-agent/workflow.test.ts` |
| 多租户检索无泄漏 | `__tests__/packages/retrieval/*.test.ts`、E2 报告 |
| checkpoint 与幂等恢复 | `__tests__/packages/persistence/runtime.integration.test.ts` |
| SSE 补发和跨端生命周期 | `__tests__/packages/rn-agent-sdk/session.test.ts`、生命周期实验台 |
| 第二 Agent 复用 | `__tests__/apps/api/runs.test.ts` |
| PaaS 元数据与 MCP 一致性 | `__tests__/packages/paas-metadata/compiler.test.ts`、`__tests__/mcp-servers/paas-tools/server.test.ts` |
