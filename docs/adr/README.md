# Architecture Decision Records

ADR 记录已经接受的架构决策。`Accepted` 表示团队接受该方向，不表示对应代码已经完成；实际完成度以里程碑和验收报告为准。

| ADR | 决策 | 状态 |
| --- | --- | --- |
| [0001](0001-independent-runtime-and-monorepo.md) | 独立 Runtime 与 Monorepo 模块化单体 | Accepted |
| [0002](0002-constrained-dynamic-langgraph.md) | 受约束动态 LangGraph 工作流 | Accepted |
| [0003](0003-postgres-and-qdrant.md) | PostgreSQL 事实源与 Qdrant 派生索引 | Accepted |
| [0004](0004-tool-registry-and-mcp.md) | Tool Registry 治理内核与 MCP 适配层 | Accepted |
| [0005](0005-replayable-sse-events.md) | 持久化事件日志与可回放 SSE | Accepted |
| [0006](0006-multitenant-defense-in-depth.md) | JWT 之外的多租户纵深防御 | Accepted |
| [0007](0007-web-server-state-and-event-projection.md) | Web 服务端状态与 SSE 事件投影分离 | Accepted |
| [0008](0008-paas-metadata-compiler-and-trusted-mcp-context.md) | PaaS 元数据编译器与可信 MCP 上下文 | Accepted |

新决策需要说明上下文、选择、后果、替代方案和可验证条件。已接受 ADR 不直接覆写结论；方向变化时新增 ADR 取代旧记录。
