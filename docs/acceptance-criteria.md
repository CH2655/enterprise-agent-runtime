# 验收标准

## 1. 全局 Definition of Done

一个能力只有同时满足以下条件才算完成：

- 代码位于正确架构边界内，依赖方向符合设计。
- 正常路径、失败路径和权限负向路径有自动化测试。
- 错误被转换成稳定的领域错误或事件，不只打印日志。
- 租户、用户和敏感内容不进入不受控日志。
- README 与架构文档反映真实实现状态。
- 类型检查、单元测试和集成测试在全新环境可重复通过。

## 2. M1 验收：可靠 Runtime

### AC-RUN-01 Run 持久化

创建 Run 后重启 API，使用同一租户 JWT 查询，输入、Agent 版本、状态和时间戳保持一致。

### AC-RUN-02 checkpoint 恢复

Run 在 `waiting_approval` 暂停后重启服务，审批可从持久化 checkpoint 恢复并进入 `completed`，不得重新执行已完成的只读节点。

### AC-RUN-03 状态机约束

- 非 `waiting_approval` Run 不接受审批。
- `completed`、`failed`、`cancelled` 为终态，不能非法回到 `running`。
- 所有状态转换记录操作者和时间。

### AC-IDEM-01 并发审批

对同一 Run 并发发送两个批准请求：只有一个审批决策生效，`create_rectification_task` 最多产生一次业务副作用，两个调用均得到可解释结果。

### AC-IDEM-02 崩溃窗口

在“下游写入成功、Run 尚未标记完成”的位置注入故障；恢复后复用相同幂等键，不创建第二个任务。

### AC-EVENT-01 持久化顺序

每个 Run 的事件 `sequence` 唯一且单调递增。重启后追加事件继续递增，不从 1 重新开始。

### AC-EVENT-02 断线补发

客户端消费到序号 N 后断线，期间继续产生事件；使用 `after=N` 重连可按序获得全部缺失事件。

### AC-AUTH-01 JWT

无 Token、签名错误、过期、错误 `issuer` 或 `audience` 的请求均被拒绝；请求体中的 `tenantId` 不得覆盖 Token 身份。

### AC-TENANT-01 跨租户矩阵

tenant-b 对 tenant-a 的以下访问全部失败且不泄漏对象内容：Run、Event、SSE、Approval、Evidence、Tool Invocation、Finding、Writeback。

### AC-TOOL-01 工具治理

- 输入和输出不符合 Schema 时执行失败。
- 未授权 Scope 或对象权限时工具体不执行。
- 未审批或无幂等键的写工具不执行。
- 超时与失败产生审计和对应 Agent Event。

## 3. M2 验收：风控业务闭环

当前实现状态：AC-LOOP-01、AC-LOOP-02、AC-LOOP-03 的自动化场景已建立；其余条目随 RAG、真实模型评测和 Web 工作台继续实施。

### AC-LOOP-01 动态补充取证

测试案件缺少银行流水时，第一轮评估产生 `cash_flow` 缺口，第二轮计划只选择允许的补充工具，不重复调用无关已成功工具。

### AC-LOOP-02 有界终止

工具持续失败时，Run 在最大 3 轮或预算上限内进入 `waiting_input`/人工补充状态，不发生无限循环。

### AC-LOOP-03 非法计划

模型返回未知工具、写工具、错误参数或超过预算的计划时，策略校验拒绝该计划并生成可观察事件。

### AC-MODEL-01 结构化输出

真实模型的计划和 Finding 必须通过 Zod Schema。重试后仍无效则进入明确失败或人工处理状态，不使用未校验文本执行工具。

### AC-RAG-01 多租户检索

tenant-a 和 tenant-b 写入内容冲突的制度条款。任一租户检索结果只包含自身允许的 Chunk，跨租户命中数必须为 0。

### AC-RAG-02 文档版本

发布新制度版本后，新 Run 只检索活动版本；历史 Run 仍能通过 Evidence 定位到当时使用的版本和原文位置。

### AC-RAG-03 Outbox 恢复

模拟 Qdrant 不可用：文档事务成功、索引状态为失败/等待；恢复 Qdrant 后重试成功，不重复产生活动 Chunk。

### AC-EVIDENCE-01 引用完整性

每个 Finding 至少引用一个已登记 Evidence；伪造或不存在的 Evidence ID 使验证失败，不能进入批准写回。

### AC-EVIDENCE-02 引用定位

知识 Evidence 至少包含文档 ID、版本、Chunk ID 和页码/章节/字符范围之一；工作台可展开对应原文。

### AC-WEB-01 完整流程

用户可从 Web 完成创建尽调、观察执行、查看 Finding 与 Evidence、审批和查看整改结果，无需通过命令行修改状态。

### AC-WEB-02 事件投影

历史回放和实时 SSE 存在重叠、乱序到达或重复事件时，Event Projector 根据 sequence 得到一致时间线，不出现已完成节点回退为运行中。

### AC-WEB-03 刷新恢复

在运行中和等待审批两个状态刷新页面，工作台均能通过 URL 中的 Run ID 恢复服务端快照和事件时间线。

## 4. M3 验收：平台复用

### AC-META-01 元数据工具

从一个真实或脱敏的 PaaS 对象元数据生成 Tool Schema，字段类型、必填、读写能力和敏感字段策略可验证。

### AC-MCP-01 协议一致性

同一工具通过 LangGraph 内部调用和 MCP 调用时使用相同 Registry 定义，并产生一致的授权、审计和幂等结果。

### AC-RN-01 生命周期恢复

RN 客户端订阅 Run 后切后台，期间产生事件；恢复前台后从最后 sequence 补发，不重复创建任务或展示重复事件。

### AC-REUSE-01 第二 Agent

Contract Agent 能注册、运行、产生 Evidence、暂停审批和完成写回；实现过程中不修改 Runtime 的业务无关接口，不复制 Event Store 和审批内核。

## 5. 评测验收

### 数据集

- 至少 20 个脱敏风控案件，覆盖正常、信用风险、资金异常、材料缺失和工具失败。
- 至少 30 个制度检索问题及人工标注相关 Chunk。
- 至少 10 个 Prompt/参数形式的跨租户攻击样例。

### 指标目标

| 指标 | 计算方式 | 目标 |
| --- | --- | --- |
| Retrieval Recall@5 | 标注相关 Chunk 是否出现在前 5 | >= 0.85 |
| Citation Accuracy | 引用是否支持 Finding 且定位正确 | >= 0.90 |
| Evidence Validity | Finding 引用 ID 是否存在 | 1.00 |
| Tenant Leakage | 跨租户命中或读取数量 | 0 |
| Recovery Pass Rate | 故障注入场景通过数/总数 | 1.00 |
| Duplicate Side Effects | 重试和并发造成的重复写入 | 0 |

任务成功率、P50/P95 延迟和 Token 成本先记录实测基线，再根据结果决定优化目标。

## 6. 标准面试演示验收

固定演示必须在 5 至 8 分钟内完成：

1. 使用 tenant-a 登录工作台并发起尽调。
2. 展示动态计划、并行工具调用和 Evidence 增长。
3. 展示一次缺失证据后的补充 Loop。
4. 打开制度原文并验证 Finding 引用。
5. 在等待审批时重启 API，恢复后继续审批。
6. 连续提交两次审批，证明只创建一个整改任务。
7. 切换 tenant-b，证明无法读取 tenant-a Run 和制度。
8. 展示审计时间线和一页真实评测结果。

## 7. 简历表述门槛

- 通过 M1：可写“实现持久化 Run、事件回放、租户隔离和幂等审批内核”。
- 通过 M2：可写“完成项目风控 Agent 与 Web 工作台闭环”。
- 通过 M3：可写“建设企业 Agent Runtime 平台，支持 PaaS 元数据工具、MCP 和 Web/RN 多端”。
- 未通过的能力只能列为设计或规划，不写成已完成成果。

## 8. M1 验收记录（2026-08-19）

| 验收项 | 状态 | 自动化证据 |
| --- | --- | --- |
| AC-RUN-01 | 通过 | 关闭并重建 Runtime 后读取同一 PostgreSQL Run |
| AC-RUN-02 | 通过 | `PostgresSaver` 从 `waiting_approval` checkpoint 恢复至 `completed` |
| AC-RUN-03 | 通过 | 状态与审计事务提交，记录前后状态、操作者、原因和时间 |
| AC-IDEM-01 | 通过 | 双并发审批仅一项成功且仅一次写工具完成记录 |
| AC-IDEM-02 | 通过 | 注入 completed 保存失败，恢复后仅一次整改任务 |
| AC-EVENT-01 | 通过 | 数据库事务分配 sequence，10 路并发仍唯一连续 |
| AC-EVENT-02 | 通过 | `after=sequence` 持久化回放与 SSE 补发 |
| AC-AUTH-01 | 通过 | JWT 签名、issuer、audience、Claims 身份负向测试 |
| AC-TENANT-01 | 部分通过 | Run/Event/Approval 已隔离；产物与审计查询 API 待增加后补齐矩阵 |
| AC-TOOL-01 | 通过 | Schema、Scope、对象权限、审批、幂等和超时均在工具执行体前治理 |

测试命令：

```bash
TEST_DATABASE_URL=postgresql://ear:ear_dev@127.0.0.1:5434/ear pnpm check
```

当前结果：6 个测试文件、22 个测试通过。M1 工程闭环已完成；AC-TENANT-01 的产物/审计读模型 API 矩阵作为增强项保留，不将其描述为已完成。
