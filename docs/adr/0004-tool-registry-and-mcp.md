# ADR-0004：Tool Registry 治理内核与 MCP 适配层

- 状态：Accepted
- 日期：2026-08-19

## 上下文

业务工具既可能被内部 LangGraph Agent 调用，也可能通过 MCP 暴露给兼容客户端。若每种协议直接调用业务接口，Schema、权限、审计和幂等会重复且容易绕过。

## 决策

- Tool Registry 是唯一工具定义和执行入口。
- 每个工具声明输入输出 Schema、读写级别、Scope、对象权限策略、超时和敏感字段策略。
- MCP Server 将 Registry 中允许暴露的工具转换为 MCP 能力，但执行仍回到 Registry。
- PaaS 元数据生成 Tool Schema；元数据只描述能力，Runtime 注入可信身份。
- 写工具必须具备审批凭据和稳定幂等键。

## 后果

- 内部 Agent、MCP 和未来 Skill 可以复用同一治理策略。
- Registry 会成为关键安全边界，需要更高测试覆盖。
- 协议 Schema 与业务 Schema 之间需要版本和兼容性管理。

## 未选择方案

- Agent 直接调用数据库或业务 API：无法统一授权和审计。
- MCP Server 自己实现工具逻辑：会形成第二套治理路径。
- 模型动态生成 SQL：权限和数据泄漏风险不可接受。

## 验证

- 内部调用与 MCP 调用产生相同审计格式。
- 未授权 Scope、跨对象访问和未经审批的写工具均被拒绝。
- 同一幂等键通过不同协议重复调用仍只产生一次副作用。
