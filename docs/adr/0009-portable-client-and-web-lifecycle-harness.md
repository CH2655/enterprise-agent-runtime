# ADR 0009：跨端客户端内核与 Web 生命周期验证台

- 状态：Accepted
- 日期：2026-08-20

## 上下文

Runtime 需要被 Web 和 React Native 共同调用。RNModules 是包含私有原生依赖和历史工程环境的大型业务仓库，完整启动它不是 Agent Runtime 的稳定验收前提；只写一个 RN 页面又无法证明断线补发、游标恢复和重复提交收敛是否真正成立。

## 决策

- `rn-agent-sdk` 保持框架无关，只依赖稳定领域协议和标准 SSE 解析器。
- SDK 提供 App 生命周期、会话存储和 Transport 端口，并提供不直接导入 React Native 的 `AppState` 适配器工厂。
- RNModules 只负责注入 `AppState`、持久化存储、JWT 和页面状态投影，不能成为服务端或 SDK 的依赖。
- Web 工作台提供生命周期实验台，使用真实 Contract Agent、API、SSE 和浏览器存储模拟移动端前后台。
- 自动化测试验证 RN AppState 适配、浏览器可见性适配、存储校验、后台补发、事件去重和并发启动收敛。
- 架构测试禁止 SDK 依赖 React、React Native、Zustand 和 Web 应用。

## 后果

- 无需启动旧 RN 工程即可重复演示大部分跨端协议与恢复语义。
- Web 实验台可以观察创建请求数、补发请求、恢复事件和最后游标，面试演示不依赖原生构建环境。
- 真实 RN 的网络栈、系统杀进程和厂商后台策略仍需在可运行 App 中做设备测试；当前只声明适配器契约和协议恢复通过。
- 包名暂时保留 `rn-agent-sdk` 以维持里程碑连续性，其内部定位是可被 Web/RN 共用的 Agent Client Core。

## 未选择方案

- 强制修复并运行整个 RNModules：验收会被私有原生依赖、证书和历史构建环境绑架。
- 单独维护 Web 与 RN 两套恢复代码：游标和去重语义容易漂移。
- 只使用 Mock Transport 做页面演示：无法证明真实 API、SSE 和审批事件可以闭环。
- 将 Zustand 或 Redux 放进 SDK：会使协议内核绑定具体宿主应用。

## 验证

1. 新建合同审查任务时并发调用两次 `session.start()`，服务端创建请求计数为 1。
2. 收到 `approval.required` 后切到后台，SDK 关闭 SSE 并保留最后 sequence。
3. 后台执行真实审批，服务端继续产生工具、审批和完成事件。
4. 恢复前台后 SDK 从最后 sequence 补发，页面时间线无重复并到达 `completed`。
5. RN AppState 和持久化适配器契约测试、架构依赖测试和全量类型检查通过。
