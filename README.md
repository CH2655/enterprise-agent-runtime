# Enterprise Agent Runtime

面向企业 PaaS 的多租户 Agent 执行与治理项目，以“项目风控与供应商准入尽调”为首个标杆业务，目标是让 AI 能够受控读取企业数据、生成可追溯结论、等待人工审批并安全回写业务系统。

> 当前仓库已完成 M1 可靠 Runtime 的核心实现：PostgreSQL 持久化、JWT 身份、LangGraph checkpoint、人工审批、事件回放和写工具幂等均已接入并通过真实数据库集成测试。真实模型、Qdrant、Web、MCP、RN SDK 和第二 Agent 属于后续里程碑，尚不能作为已实现能力表述。

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
- 离线 Mock 工具和确定性规则，不需要模型 API Key。
- 6 个测试文件、22 个测试；真实 PostgreSQL 17 集成测试覆盖重启恢复、审批并发、崩溃窗口、事件并发序号、持久化幂等、状态审计和对象权限拒绝。

## 当前限制

- 未配置 `DATABASE_URL` 时使用内存基础设施，仅适合快速开发；可靠性演示必须使用 PostgreSQL。
- PostgreSQL checkpointer 表由 LangGraph 官方 checkpointer 管理，业务表由 Drizzle migration 管理。
- 自动恢复目前在 API 启动时执行单次扫描；多副本部署需要增加恢复租约或数据库抢占机制。
- 事件与 Run 创建、Run 状态与 Evidence/Finding 保存尚未合并为单个业务事务，故障后需要校准。
- 对象权限接口与规则适配器已经实现，真实 PaaS 权限服务客户端尚未接入。
- “最多一次业务副作用”依赖稳定幂等键和下游适配器遵守该键，不宣称分布式 exactly-once。
- 风险结论、业务工具和制度检索都是 Mock，没有真实 LLM 和 RAG。
- 当前取证 Loop 结构存在，但 Mock 数据首轮即达到 100% 覆盖，尚未实现动态补充计划。
- 只有 Risk Agent，没有 Web/RN 客户端和第二业务 Agent。

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
agents/risk-agent/         风控业务工作流和 Mock 工具
packages/domain/           Evidence、Finding、Run 状态等契约
packages/agent-runtime/    Agent 注册、Run 和审批入口
packages/tool-registry/    工具治理、幂等、超时和审计
packages/agent-protocol/   事件、sequence、补发和订阅
packages/auth/             JWT Claims 到可信 IdentityContext
packages/persistence/      Drizzle Schema、PostgreSQL Repository 和审计
__tests__/                 工作流与平台包测试
docs/                      PRD、架构、ADR、里程碑与验收
```

目标结构会在对应里程碑实施时增加 `apps/web`、`packages/retrieval`、`packages/model-provider`、`packages/rn-agent-sdk` 和 `mcp-servers/paas-tools`。

## 本地运行

要求 Node.js 22+ 和 pnpm。

```bash
pnpm install
pnpm check
pnpm dev
```

API 默认运行在 `http://127.0.0.1:3001`。

M1 PostgreSQL 本地环境准备：

```bash
pnpm db:up
pnpm db:migrate
TEST_DATABASE_URL=postgresql://ear:ear_dev@127.0.0.1:5434/ear pnpm test:integration
```

数据库默认监听 `127.0.0.1:5434`，配置示例见 `.env.example`。设置 `DATABASE_URL` 后 API 自动装配 PostgreSQL Repository 与 `PostgresSaver`；不设置则使用内存实现。

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
- M2：真实风控业务闭环与 Web 工作台。
- M3：PaaS 元数据工具、MCP、RN SDK 和第二 Agent。
- M4：评测固化与面试交付。

只有通过对应[验收标准](docs/acceptance-criteria.md)的能力，才能进入简历成果描述。
