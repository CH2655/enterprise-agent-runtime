# ADR-0007：Web 服务端状态与 SSE 事件投影分离

- 状态：Accepted
- 日期：2026-08-20

## 上下文

工作台同时消费 Run 快照、任务列表和持续到达的 Agent Event。如果把三者全部复制到全局前端 Store，会出现服务端事实与客户端副本竞争、刷新恢复困难和重复事件导致节点状态回退的问题。

原生 `EventSource` 不能为 Demo 租户头或 Bearer Token 自定义请求 Header，也不适合作为本项目唯一的认证事件客户端。

## 决策

- TanStack Query 管理任务列表、Run 快照和审批 Mutation，服务端仍是业务事实来源。
- Zustand 只管理 SSE 连接状态、每个 Run 的 `lastSequence` 和派生时间线，不保存 Run 业务快照。
- Event Projector 以 `sequence` 为唯一顺序，合并历史回放和实时事件，重复事件幂等忽略，乱序到达后重新排序投影。
- 使用流式 `fetch` 读取 SSE，使 Demo Header 和 JWT Authorization Header 复用同一客户端。
- Run ID 写入 `/runs/:runId`，刷新时重新获取快照、从历史事件恢复投影并接续 SSE。
- Web 创建任务使用显式异步 API 模式；同步模式保留给确定性测试和内部调用。

## 后果

- 刷新或前端重启不会依赖 Zustand 中的旧业务数据。
- 历史回放和实时订阅存在重叠时不会重复展示事件。
- 自定义 SSE 解析器需要维护分帧、取消、退避重连和错误处理。
- 当前异步执行由 API 进程调度，不等价于持久化任务队列；进程在调度窗口崩溃时需要后续租约/队列机制恢复。

## 未选择方案

- 全部放入 Zustand：会复制服务端事实并增加一致性维护成本。
- 只轮询 Run：无法展示完整工具时间线，实时性和协议复用价值不足。
- 原生 EventSource：不能满足当前 Header 鉴权要求。
- WebSocket：当前事件是服务端单向推送，SSE 的回放游标和代理兼容性更合适。

## 验证

- 单元测试覆盖历史与实时重叠、重复 sequence、乱序到达和终态不回退。
- 浏览器刷新 `/runs/:runId` 后恢复 Run、Evidence 和完整时间线。
- 审批后 Query 快照、任务列表和 SSE 时间线收敛到 `completed`。
