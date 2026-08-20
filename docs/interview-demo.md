# 面试演示手册

## 1. 演示目标

在 5 至 8 分钟内证明四件事：这是业务执行 Agent，不是聊天壳；关键结论有 Evidence；写操作受审批、权限和幂等约束；同一 Runtime 可以复用到第二业务和 Web/RN 客户端。

## 2. 启动方式

零密钥快速演示：

```bash
pnpm install
pnpm demo
```

完整基础设施演示：

```bash
pnpm demo:full
```

默认地址为 `http://127.0.0.1:5173`。端口冲突时：

```bash
pnpm demo -- --api-port=3101 --web-port=5181
```

`demo` 强制使用确定性模型，不读取百炼 Key，不产生模型费用。`demo:full` 在此基础上增加 PostgreSQL、Qdrant 和数据库迁移；真实模型质量应展示已固化的 E2 报告，不在面试现场临时消耗 Token。

## 3. 固定演示数据

| 租户 | 场景 | 预期状态 | 用途 |
| --- | --- | --- | --- |
| tenant-a | `DEMO-RISK-001` | `waiting_approval` | Finding、Evidence、审批和写回 |
| tenant-a | `DEMO-CONTRACT-001` | `completed` | 第二 Agent 与平台复用 |
| tenant-b | `DEMO-RISK-B-001` | `waiting_approval` | 多租户列表与数据隔离 |

种子脚本按业务编号识别已有场景，可重复执行，不重复创建或审批。

关键截图：

- [风控工作台](assets/workbench-risk.jpg)
- [生命周期恢复实验台](assets/lifecycle-recovery.jpg)
- [生命周期恢复实验台移动端](assets/lifecycle-recovery-mobile.jpg)

## 4. 七分钟标准演示

### 0:00-0:40：先讲业务问题

打开任务列表，说明项目解决的是供应商准入尽调：Agent 读取项目、供应商、企业信用、资金流水和制度，形成可追溯结论；它不能直接写业务系统，必须经过人工审批。

不要从 LangGraph、MCP 或向量库开场。先让面试官知道为什么需要这个系统。

### 0:40-1:40：展示受约束动态 Loop

打开 `DEMO-RISK-001` 的执行记录：

- `plan -> collect -> evaluate` 是动态决策面。
- 工具白名单、最多三轮、预算和退出条件是确定性控制面。
- 缺失资金证据时只补取缺失维度，成功工具不重复执行。

关键表述：模型负责提出候选计划，代码负责判断它能不能执行。

### 1:40-2:40：展示 Evidence 与 Finding

打开风险结论引用的 Evidence：

- 业务对象证据来自受控 Tool Registry。
- 制度证据包含文档版本、Chunk、章节和行号定位。
- Finding 引用不存在的 Evidence ID 时无法进入审批。

关键表述：RAG 结果不是直接答案，而是先登记为 Evidence，再由校验器约束 Finding。

### 2:40-3:35：展示审批与幂等写回

打开审批弹窗，展示将执行的动作和幂等键，然后批准：

- 写工具要求审批凭据和 `risk:write` Scope。
- 并发审批只有一个决策成功。
- 下游成功、Run 状态回写失败时，恢复仍复用相同幂等键。

避免使用“分布式 exactly-once”。准确说法是：稳定幂等键下，受测业务副作用最多一次。

### 3:35-4:20：展示租户隔离

切换 tenant-b：tenant-a 的 Run 不应出现在列表。说明租户身份来自 JWT Claims 或显式 Demo Header，不接受模型或请求体提供的 `tenantId`；API、Repository、工具和向量过滤分别防御。

### 4:20-5:35：展示跨端生命周期恢复

进入“恢复实验台”：

1. 新建验证任务，观察“提交/创建”为 `2/1`。
2. 收到待审批后进入后台，记住后台游标。
3. 后台完成审批，客户端事件仍停在原游标。
4. 恢复前台，观察补发事件、最终游标和三个通过项。

关键表述：Web 在这里是协议实验台，RN AppState 和存储通过适配器契约测试；没有宣称已完成真机系统杀进程验证。

### 5:35-6:25：展示平台复用

打开已完成的 `DEMO-CONTRACT-001`：合同 Agent 复用相同 Run、事件、Evidence、审批、Tool Registry 和幂等写回，没有复制第二套 Runtime。PaaS 元数据编译器生成 Tool Schema，MCP 只是 Tool Registry 的协议适配层。

### 6:25-7:00：用评测收尾

打开 `evals/reports/latest.e2.md`：三轮均使用 30 个检索问题、20 个风险案件、10 个攻击样例；展示 Recall@5、引用准确率、恢复率、租户泄漏、P95 和成本，同时主动说明数据为合成且领域限定。

## 5. 30 至 60 分钟展开顺序

| 时间 | 主题 | 代码或文档锚点 |
| --- | --- | --- |
| 0-8 分钟 | 产品闭环与现场演示 | 工作台、生命周期实验台 |
| 8-18 分钟 | Runtime、Agent Registry、Tool Registry | `packages/agent-runtime`、`packages/tool-registry` |
| 18-28 分钟 | 动态 Loop、结构化输出、Evidence 校验 | `agents/risk-agent`、ADR 0002 |
| 28-38 分钟 | checkpoint、事件回放、审批竞争、幂等 | ADR 0005、持久化集成测试 |
| 38-46 分钟 | RAG、多租户、Outbox 与 Qdrant | `packages/retrieval`、ADR 0003/0006 |
| 46-53 分钟 | React 工作台与跨端 SDK | ADR 0007/0009、`LifecycleLab.tsx` |
| 53-58 分钟 | PaaS 元数据、MCP、第二 Agent | ADR 0004/0008、合同 Agent |
| 58-60 分钟 | 指标边界、当前限制和下一步 | 评测摘要、README 限制 |

## 6. 演示故障预案

| 现场问题 | 处理 |
| --- | --- |
| Docker 不可用 | 使用 `pnpm demo`，可靠性证据切换到集成测试与 E2 报告 |
| 端口占用 | 使用 `--api-port`、`--web-port` 指定新端口 |
| 网络或百炼不可用 | 演示模式本来就不调用外部模型；展示固化 E2 报告 |
| 浏览器 SSE 被代理阻塞 | API 会立即发送 SSE 注释心跳完成首字节握手 |
| 工作台已有旧数据 | 固定业务编号会复用已有场景；切换状态筛选即可 |
| 时间不足 | 只演示 Evidence、审批、生命周期恢复和 E2 报告四个画面 |

## 7. 演示结束检查

- 明确哪些是已实现，哪些是真实 PaaS/RN 接入边界。
- 不把合成评测扩展成生产 SLA。
- 不把内存快速演示说成持久化恢复证明。
- 不把幂等语义描述成不可能失败的 exactly-once。
- 回答始终回到业务问题、控制边界和可验证证据。
