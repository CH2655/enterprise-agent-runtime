# Enterprise Agent Runtime

面向企业 PaaS 的多租户 Agent 执行与治理项目，以“项目风控与供应商准入尽调”为首个标杆业务，目标是让 AI 能够受控读取企业数据、生成可追溯结论、等待人工审批并安全回写业务系统。

> 当前仓库已完成 M1 可靠 Runtime，并完成 M2 风控业务的后端与 Web 人机协作闭环。E0 已建立版本化评测集、确定性运行器和指标报告；真实百炼模型、真实 Qdrant 质量基线仍属于后续工作。

## 产品闭环

```text
用户发起供应商尽调
  -> Agent 规划并调用受控业务工具
  -> 收集项目、供应商、企业风险、流水和制度 Evidence
  -> 评估覆盖率并补充取证
  -> 生成带 Evidence 引用的 Finding
  -> 人工审批
  -> 幂等创建整改任务
```

该项目不是聊天机器人或通用 Coze 平台。Runtime 提供跨业务、跨终端复用的执行治理能力；Risk Agent 是第一个业务实现；Web 和 RN 是同一 Run/Event 协议的客户端。

## 当前已实现

- TypeScript + Fastify API 和 pnpm Monorepo。
- LangGraph 风控状态图：取证、覆盖评估、结论生成和引用校验。
- Agent Registry 与 Repository 抽象，业务 Agent、平台内核和持久化实现分离。
- Tool Registry：Zod 输入输出校验、Scope 校验、可信租户上下文、写工具审批、持久化幂等、超时和审计。
- Evidence 与 Finding 引用校验，Finding 不能引用不存在的 Evidence ID。
- PostgreSQL 持久化 Run、Event、Approval、Evidence、Finding、Tool Invocation 和 Idempotency；事件 sequence 由数据库事务分配。
- LangGraph `interrupt()` + PostgreSQL checkpointer，服务重建后可恢复等待审批的 Run。
- 人工确认且具备 `risk:approve`、`risk:write` Scope 后，才能调用模拟写工具创建整改任务。
- 写回成功但 Run 状态回写失败时，可依据审批事实和最终 checkpoint 校准状态，不重复创建整改任务。
- 统一 Agent Event、历史补发和 SSE 在线订阅。
- JWT 模式校验签名、`issuer` 和 `audience`，身份只从可信 Claims 构建；本地开发保留显式 Demo 模式。
- Run 状态转换与 Run 更新在同一事务提交，记录前后状态、操作者、原因和时间，并提供租户隔离的查询 API。
- Tool Registry 在工具执行前按 RNModules/PaaS 的 `appName + metaName + action + objectId` 语义校验对象权限。
- API 启动时自动扫描“审批已完成但 Run 未结束”的记录，从持久化 checkpoint 校准或恢复执行。
- Model Provider 契约、可脚本化确定性实现、OpenAI Responses Structured Outputs 和百炼 Chat Completions JSON Mode 实现。
- 受约束动态 Loop：`plan -> collect -> evaluate -> replan`，只允许只读工具、最多三轮、成功工具不重复。
- 模型生成候选 Finding，确定性代码继续负责工具白名单、参数构造、Evidence 引用校验和写操作审批。
- 未配置模型 Key 时使用离线确定性 Provider，完整流程可重复测试。
- Markdown 文档入库、章节分块、内容哈希、活动版本切换和权限标签。
- PostgreSQL 事务内同时提交文档、Chunk 与 Outbox；Qdrant 暂时失败时任务保留并可重试，崩溃后的陈旧锁可回收。
- 确定性 Embedding 与 OpenAI Embeddings Provider；本地测试无需外部 API。
- Qdrant REST 适配器：集合维度校验、`tenant_id` 租户索引、租户过滤、文档版本替换与向量查询。
- Risk Agent 的制度工具接入真实 Knowledge Search，Evidence 保存文档 ID、版本、Chunk、章节和行号 locator。
- 检索 API 按可信身份注入租户，并在 PostgreSQL 活动版本校验后执行权限标签过滤。
- React + Vite 风控工作台：租户任务列表、状态筛选、URL Run 恢复、风险报告、Evidence 原文、审批与整改结果。
- TanStack Query 管理服务端 Run 快照，Zustand 只保存 SSE 连接、事件序列和时间线投影。
- Web 使用带身份 Header 的流式 `fetch` 消费 SSE；历史回放与实时事件按 `sequence` 去重，断线后从游标补发。
- Web 创建 Run 使用异步模式立即返回 `running`；同步模式继续保留给测试和内部调用。
- Demo 模式自动为两个租户建立内容冲突的制度，便于验证向量检索隔离。
- E0 评测运行器覆盖 6 个风控路径、8 个制度问题和 3 个越权样例，输出 JSON/Markdown 可追溯报告。
- 自动化测试覆盖重启恢复、审批并发、崩溃窗口、动态补取、非法计划、有界终止、跨租户检索、版本切换、Outbox 重试和 Evidence 定位。

## 当前限制

- 未配置 `DATABASE_URL` 时使用内存基础设施，仅适合快速开发；可靠性演示必须使用 PostgreSQL。
- PostgreSQL checkpointer 表由 LangGraph 官方 checkpointer 管理，业务表由 Drizzle migration 管理。
- 自动恢复目前在 API 启动时执行单次扫描；多副本部署需要增加恢复租约或数据库抢占机制。
- 事件与 Run 创建、Run 状态与 Evidence/Finding 保存尚未合并为单个业务事务，故障后需要校准。
- 对象权限接口与规则适配器已经实现，真实 PaaS 权限服务客户端尚未接入。
- “最多一次业务副作用”依赖稳定幂等键和下游适配器遵守该键，不宣称分布式 exactly-once。
- OpenAI 兼容 Provider 已实现但未使用百炼 Key 建立质量/延迟/成本基线；默认仍运行确定性 Provider。
- 项目、供应商、企业风险、流水和整改写回仍为 Mock；制度检索已经接入知识库。
- 文档解析当前支持 Markdown 章节和行号，不包含 PDF/OCR。
- Qdrant 适配器有协议级自动化测试；尚未建立真实 Qdrant 容器的持续集成和检索质量基线。
- OpenAI Model/Embedding Provider 已实现，但未使用真实 Key 建立质量、延迟和成本基线。
- 只有 Risk Agent 和 Web 客户端，没有 RN 客户端和第二业务 Agent。
- Web 异步启动目前使用进程内调度；API 在返回 `running` 后立刻崩溃时，缺少持久化执行队列自动接管该 Run。

## 架构原则

```text
Web / React Native
        |
    Fastify API
        |
   Agent Runtime
   /           \
Risk Agent   Contract Agent
   \           /
     Tool Registry
      /       \
PaaS Tools   Retrieval
                 |
               Qdrant

PostgreSQL 保存 Run、checkpoint、事件、Evidence、审批和审计事实。
```

- 固定控制面：权限、预算、退出条件、Evidence 校验、审批和幂等。
- 动态决策面：取证计划、缺失维度、允许工具选择和 Finding 生成。
- Tool Registry 是唯一执行入口，MCP 只是协议适配层。
- PostgreSQL 是事实来源，Qdrant 是通过 Outbox 更新的可重建索引。
- Web 使用 TanStack Query 管理服务端事实，Zustand 只管理实时事件投影。
- RN SDK 不绑定状态框架，接入 RNModules 时沿用既有 Redux 体系。

## 文档

- [产品需求文档](docs/prd.md)
- [总体架构](docs/architecture.md)
- [架构边界](docs/architecture-boundaries.md)
- [架构决策记录](docs/adr/README.md)
- [实施里程碑](docs/milestones.md)
- [验收标准](docs/acceptance-criteria.md)

## 项目结构

```text
apps/api/                  Fastify API 与依赖装配
apps/web/                  React/Vite 风控工作台与 SSE 事件投影
agents/risk-agent/         风控业务工作流和 Mock 工具
packages/domain/           Evidence、Finding、Run 状态等契约
packages/agent-runtime/    Agent 注册、Run 和审批入口
packages/tool-registry/    工具治理、幂等、超时和审计
packages/agent-protocol/   事件、sequence、补发和订阅
packages/auth/             JWT Claims 到可信 IdentityContext
packages/persistence/      Drizzle Schema、PostgreSQL Repository 和审计
packages/model-provider/   结构化模型契约、离线实现和 OpenAI Provider
packages/retrieval/        文档分块、Embedding 编排、Outbox Worker 与 Qdrant 适配
evals/                     版本化数据集、E0 运行器、指标和评测报告
__tests__/                 工作流与平台包测试
docs/                      PRD、架构、ADR、里程碑与验收
```

目标结构会在对应里程碑实施时增加 `packages/rn-agent-sdk` 和 `mcp-servers/paas-tools`。

## 本地运行

要求 Node.js 22+ 和 pnpm。

```bash
pnpm install
cp .env.example .env
pnpm check
pnpm dev:api
pnpm dev:web
```

API 默认运行在 `http://127.0.0.1:3001`，Web 工作台运行在 `http://127.0.0.1:5173`。两个开发服务分别在终端启动。

PostgreSQL 与 Qdrant 本地环境准备：

```bash
pnpm db:up
pnpm db:migrate
TEST_DATABASE_URL=postgresql://ear:ear_dev@127.0.0.1:5434/ear pnpm test:integration
```

PostgreSQL 默认监听 `127.0.0.1:5434`，Qdrant 默认监听 `127.0.0.1:6333`，配置示例见 `.env.example`。设置 `DATABASE_URL` 后 API 自动装配 PostgreSQL Repository 与 `PostgresSaver`；设置 `QDRANT_URL` 后使用 Qdrant，否则使用内存向量索引。

API 启动脚本会读取根目录 `.env`。默认使用确定性 Model Provider；配置百炼 API Key、业务空间 Base URL 与显式模型名后，API 使用 Chat Completions JSON Mode、关闭思考并继续执行 Zod 校验。`MODEL_WIRE_API` 可显式选择 `chat_completions` 或 `responses`，百炼域名未配置该变量时自动选择前者。模型仍不能直接执行工具或构造写操作参数。

## M2 评测

零费用运行 E0 确定性基线：

```bash
pnpm eval:m2
```

报告写入 `evals/reports/latest.deterministic.json` 和 `.md`。E0 用来验证评测计算、数据 Schema 和场景覆盖，结果不能作为真实模型质量或简历指标。

确认 `.env` 配置后，可显式执行一次百炼 Embedding 与结构化输出冒烟调用：

```bash
pnpm eval:bailian:smoke
```

该命令会产生少量模型 Token 消耗，普通测试与 `pnpm eval:m2` 不会调用百炼。

运行 E1 小样本真实基线：

```bash
pnpm db:up
pnpm eval:m2:real
```

E1 使用临时 PostgreSQL 数据库和临时 Qdrant Collection，结束后自动清理；报告包含真实检索、Agent 质量、P50/P95、Token 和按 `.env` 单价估算的费用。当前数据规模仍是 8 个检索问题、5 个真实模型案件和 3 个攻击样例，未达到最终简历指标门槛。

先发布一版租户制度并完成索引：

```bash
curl -X POST http://127.0.0.1:3001/api/knowledge/documents \
  -H 'content-type: application/json' \
  -H 'x-demo-tenant: tenant-a' \
  -H 'x-demo-user: admin-1' \
  -d '{
    "documentKey": "supplier-policy",
    "version": 1,
    "title": "供应商准入制度",
    "content": "# 高风险供应商\\n存在失信记录或重大资金异常时必须人工复核。",
    "permissionTags": ["risk_reviewer"]
  }'
```

当前演示身份使用请求头，`tenantId` 不从请求体读取：

```bash
curl -X POST http://127.0.0.1:3001/api/runs \
  -H 'content-type: application/json' \
  -H 'x-demo-tenant: tenant-a' \
  -H 'x-demo-user: reviewer-1' \
  -d '{
    "agentId": "risk-agent",
    "input": {
      "caseId": "case-1",
      "projectCode": "P-1",
      "supplierCode": "S-1"
    }
  }'
```

运行会停在 `waiting_approval`。使用返回的 Run ID 完成人工确认：

```bash
curl -X POST http://127.0.0.1:3001/api/runs/<run-id>/approve \
  -H 'x-demo-tenant: tenant-a' \
  -H 'x-demo-user: reviewer-1'
```

查询指定序号后的事件：

```bash
curl 'http://127.0.0.1:3001/api/runs/<run-id>/events?after=5' \
  -H 'x-demo-tenant: tenant-a' \
  -H 'x-demo-user: reviewer-1'
```

## 当前里程碑

- M0：设计基线与原型审计，已完成。
- M1：可靠 Runtime 与多租户基础，工程闭环已完成并通过真实 PostgreSQL 验证；产物查询 API 的完整跨租户矩阵作为增强项继续补齐。
- M2：进行中；业务闭环与 E0 评测骨架已完成，真实百炼/Qdrant 质量、延迟和成本基线待实现。
- M3：PaaS 元数据工具、MCP、RN SDK 和第二 Agent。
- M4：评测固化与面试交付。

只有通过对应[验收标准](docs/acceptance-criteria.md)的能力，才能进入简历成果描述。
