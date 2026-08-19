# ADR-0001：独立 Runtime 与 Monorepo 模块化单体

- 状态：Accepted
- 日期：2026-08-19

## 上下文

Agent 需要同时服务 Web、React Native、H5 和其他企业系统，并承担长任务、SSE、暂停审批和恢复。业务 Agent 又需要共享领域契约、工具治理和事件协议。

## 决策

- 使用 pnpm workspace 管理 Monorepo。
- Fastify API 作为独立常驻 Runtime 服务。
- Web 使用 React + Vite，作为 Runtime 客户端而非宿主。
- 初期采用模块化单体，不提前拆微服务。
- `packages/` 不依赖 `agents/`，平台内核不得包含业务领域字段。

## 原因

Next.js 能实现 API，但其主要价值在 Web 渲染和 BFF。本系统的核心边界是多端共享、长时间运行的 Agent 服务，不依赖 SSR、SEO 或 React Server Components。独立 Runtime 也避免 RN 客户端被绑定到 Web 框架部署生命周期。

## 后果

- 可以独立扩展 API、Web、worker 和业务 Agent。
- 跨包契约和版本需要严格管理。
- Monorepo 不代表单进程；部署单元由实际负载决定。

## 未选择方案

- 全部放入 Next.js Route Handler：服务边界与 Web 生命周期耦合。
- 一开始拆为多个微服务：增加部署、事务和调试成本，暂无负载依据。

## 验证

- Web 和 RN 使用同一 Run/Event API。
- 新增第二 Agent 时不修改 Runtime 领域模型。
- API 可在没有 Web 应用的情况下独立运行和测试。
