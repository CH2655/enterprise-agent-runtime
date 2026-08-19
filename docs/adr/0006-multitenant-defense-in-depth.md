# ADR-0006：JWT 之外的多租户纵深防御

- 状态：Accepted
- 日期：2026-08-19

## 上下文

JWT 只能携带和证明 Claims，不能自动约束数据库、工具或向量查询。企业 Agent 会跨多个数据源执行，如果只在 API 入口检查租户，任一内部调用遗漏过滤都可能泄漏数据。

## 决策

- API 验证 JWT 的签名、签发方、受众和有效期，生成不可由业务输入覆盖的 `IdentityContext`。
- Runtime 对 Run、Event、Approval 的每次访问校验租户。
- Tool Registry 校验 Scope、对象权限和敏感字段策略。
- PostgreSQL Repository 强制租户条件；关键表使用包含 `tenant_id` 的唯一键和索引，必要时增加 RLS。
- Qdrant 服务端查询强制添加 `tenant_id` 与 `permission_tags` Filter。
- 管理权限和业务内容权限分开。

## 后果

- 即使某一层出现缺陷，其他层仍能降低泄漏风险。
- Repository 与测试数据必须始终显式包含租户。
- 平台管理员排障需要经过受审计的临时授权，而不是全局隐式放行。

## 未选择方案

- 只信任请求体 tenantId：客户端可伪造。
- 只依赖 JWT：内部数据访问仍可能遗漏隔离。
- 一个租户一套完整部署：隔离强但不符合当前 PaaS 成本与规模目标。

## 验证

- API、Run、Event、Approval、Tool、PostgreSQL 和 Qdrant 均有跨租户负向测试。
- Prompt 或工具参数中注入其他 tenantId 不改变可信上下文。
- 日志与错误响应不包含其他租户的 Evidence 内容。
