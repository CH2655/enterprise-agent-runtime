# ADR-0003：PostgreSQL 事实源与 Qdrant 派生索引

- 状态：Accepted
- 日期：2026-08-19

## 上下文

Runtime 需要事务、唯一约束和持久化恢复；知识检索需要向量搜索、Payload 过滤和独立索引能力。将业务状态和向量索引混为同一事实源，会使一致性和恢复边界不清晰。

## 决策

- PostgreSQL 保存 Run、checkpoint、事件、审计、Evidence、审批、文档元数据和 Outbox，是唯一事实来源。
- Qdrant 保存文档 Chunk 向量及租户、权限、版本和定位 Payload，是可重建派生索引。
- 使用事务 Outbox 异步更新 Qdrant，不在上传请求中直接双写两个数据库。
- 不同时引入 pgvector；Redis 暂不进入基线架构。

## 后果

- 可以使用 Qdrant 的向量检索和租户 Payload 分区能力。
- 必须实现索引状态、失败重试、删除传播和重建流程。
- 查询可能面对短暂的最终一致性，UI需展示文档索引状态。

## 未选择方案

- 只用 PostgreSQL + pgvector：部署更简单，但不符合本项目独立检索基础设施的验证目标。
- 请求内双写：任一存储失败都会产生难以恢复的不一致。
- 一个租户一个 Collection：租户数量增长后资源开销不可控。

## 验证

- PostgreSQL 提交成功而 Qdrant 暂时失败时，Outbox 可重试并最终完成。
- 删除或新版本文档后，旧 Chunk 不再被活动版本检索。
- 可清空 Qdrant 并从 PostgreSQL 重建索引。
- tenant-a 查询无法命中 tenant-b Chunk。
