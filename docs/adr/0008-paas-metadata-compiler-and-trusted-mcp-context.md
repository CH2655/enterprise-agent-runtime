# ADR-0008：PaaS 元数据编译器与可信 MCP 上下文

- 状态：Accepted
- 日期：2026-08-20

## 上下文

RNModules 已通过对象元数据驱动动态页面，并通过应用 `setup()`、Field Processor 和 TaskChain 扩展业务行为。Agent 也需要访问这些对象，但直接依赖 RN 工程会把 UI、缓存和历史兼容逻辑带入服务端；为每个 Agent 手写工具又会重复字段 Schema、权限和敏感策略。

MCP 提供外部工具协议，但协议参数来自模型，不能被当作租户身份或审批凭据。

## 决策

- PaaS 侧导出经过扩展处理后的版本化、脱敏元数据快照；Runtime 不依赖 RNModules 源码。
- `paas-metadata` 使用运行时 Schema 校验快照，并编译查询、创建、更新工具。
- 字段能力取元数据可见性、字段权限、只读状态和 Agent 敏感策略的交集，任一信息缺失时不扩大权限。
- Tool Registry 仍是唯一执行入口。只有显式声明 MCP 暴露的工具进入 MCP 目录。
- MCP Transport 负责认证，Context Resolver 将已验证身份转换为 `AgentIdentity`；业务参数中的身份、Scope 和审批信息无效。
- 本地 stdio 环境身份只用于开发演示，不能作为生产认证方案。

## 后果

- 同一对象元数据可以生成 Web/RN Agent 内部工具和 MCP 工具，Schema 不再手工漂移。
- 元数据版本会进入工具输出，便于定位配置变化导致的行为差异。
- PaaS 仍需实现真实快照和业务 API Gateway；公开仓库只能证明编译、治理和协议路径。
- 敏感字段分级必须由业务治理配置提供，编译器不能从字段名称推断。

## 未选择方案

- Runtime 直接导入 RNModules：服务端会依赖 React Native 和客户端历史兼容逻辑。
- MCP Server 直接调用 PaaS API：会绕过 Registry 的审批、幂等和审计。
- 将 `tenantId` 放入工具参数：模型可伪造身份并扩大数据边界。
- 让模型生成任意 JSON Schema：无法保证与 PaaS 权限和元数据版本一致。

## 验证

- 必填、只读、计算和敏感字段的输入输出行为有自动化测试。
- 官方 MCP Client 通过内存 Transport 完成工具发现和调用。
- 同一 Registry、同一幂等键经内部与 MCP 重复调用只产生一次业务副作用。
