# 面试架构图集

## 1. 系统全景

```mermaid
flowchart LR
    U[风控/合同审核人员] --> WEB[React 工作台]
    U --> RN[React Native 客户端]
    EXT[外部 Agent Client] --> MCP[MCP Server]
    WEB --> API[Fastify API]
    RN --> API
    API --> RT[Agent Runtime]
    RT --> AR[Agent Registry]
    AR --> RISK[Risk Agent]
    AR --> CONTRACT[Contract Agent]
    RISK --> TR[Tool Registry]
    CONTRACT --> TR
    MCP --> TR
    TR --> PAAS[PaaS Gateway/元数据工具]
    TR --> RET[Knowledge Retrieval]
    RET --> QD[(Qdrant)]
    RT --> PG[(PostgreSQL)]
    RET --> PG
    PG -->|Outbox| RET
```

边界：Runtime 不依赖 Web、RN 或 MCP Transport；Tool Registry 是所有工具执行的唯一入口；PostgreSQL 是事实源，Qdrant 是可重建派生索引。

## 2. 核心数据模型

```mermaid
erDiagram
    AGENT_RUN ||--o{ AGENT_EVENT : emits
    AGENT_RUN ||--o{ RUN_TRANSITION : records
    AGENT_RUN ||--o{ EVIDENCE : collects
    AGENT_RUN ||--o{ FINDING : produces
    FINDING }o--o{ EVIDENCE : cites
    AGENT_RUN ||--o| APPROVAL : waits_for
    AGENT_RUN ||--o{ TOOL_INVOCATION : audits
    TOOL_INVOCATION ||--o| IDEMPOTENCY_RECORD : guards
    KNOWLEDGE_DOCUMENT ||--o{ KNOWLEDGE_CHUNK : contains
    KNOWLEDGE_DOCUMENT ||--o{ OUTBOX_JOB : indexes
    AGENT_RUN {
      uuid id
      string tenant_id
      string agent_id
      string status
      json input
      json state
    }
    AGENT_EVENT {
      uuid run_id
      int sequence
      string type
      json payload
    }
    EVIDENCE {
      string id
      uuid run_id
      string source_type
      string locator
    }
    FINDING {
      string id
      uuid run_id
      string level
      float confidence
    }
```

## 3. 受约束动态 Loop

```mermaid
flowchart TD
    START[创建 Run] --> PLAN[模型生成结构化候选计划]
    PLAN --> GUARD{白名单/Scope/预算/参数校验}
    GUARD -->|拒绝| REJECT[记录 plan.rejected]
    GUARD -->|允许| COLLECT[并行执行只读工具]
    COLLECT --> REGISTER[登记 Evidence]
    REGISTER --> COVERAGE{必需维度是否覆盖}
    COVERAGE -->|缺失且轮次/预算允许| REPLAN[只规划缺失维度]
    REPLAN --> PLAN
    COVERAGE -->|缺失且达到上限| INPUT[waiting_input]
    COVERAGE -->|覆盖完成| SYNTHESIZE[模型生成候选 Finding]
    SYNTHESIZE --> VERIFY{Evidence ID与事实边界校验}
    VERIFY -->|失败| INPUT
    VERIFY -->|通过且有风险| APPROVAL[waiting_approval]
    VERIFY -->|通过且无风险| DONE[completed]
    APPROVAL --> WRITE[审批后幂等写回]
    WRITE --> DONE
```

动态的是工具选择和补证计划；固定的是可执行工具、预算、退出条件、引用校验与写审批。

## 4. 客户端断线恢复

```mermaid
sequenceDiagram
    participant C as Web/RN Client Core
    participant S as API/SSE
    participant E as Event Store
    participant A as Agent Runtime
    C->>S: startRun(clientRequestId)
    S->>A: 创建并执行 Run
    A->>E: append event #1..#9
    C->>S: replay(after=0)
    E-->>C: #1..#9
    C->>S: SSE(after=9)
    Note over C: App进入后台，保存lastSequence=9
    C-xS: close SSE
    C->>S: approve(runId)
    S->>A: resume checkpoint
    A->>E: append #10..#13
    Note over C: 前台恢复
    C->>S: replay(after=9)
    E-->>C: #10..#13
    C->>S: SSE(after=13)
    Note over C: sequence去重，状态completed
```

## 5. 审批与崩溃窗口

```mermaid
sequenceDiagram
    participant U as Reviewer
    participant API
    participant DB as PostgreSQL
    participant T as Write Tool
    U->>API: approve(runId)
    API->>DB: 原子竞争Approval
    DB-->>API: winner + approvedBy
    API->>T: execute(idempotencyKey)
    T->>DB: claim idempotency key
    T-->>API: taskId
    Note over API,DB: 注入故障：下游成功，Run尚未完成
    API--xDB: update Run failed
    API->>DB: 启动扫描/恢复checkpoint
    API->>T: execute(same idempotencyKey)
    T-->>API: 返回已有taskId
    API->>DB: 校准Run为completed
```

实际语义是审批事实唯一、稳定幂等键下副作用最多一次；不宣称跨任意下游的分布式 exactly-once。

## 6. PaaS 元数据到工具

```mermaid
flowchart LR
    META[版本化PaaS元数据快照] --> VALIDATE[运行时Schema校验]
    VALIDATE --> POLICY[字段权限/只读/敏感策略求交集]
    POLICY --> COMPILE[编译get/create/update Tool Schema]
    COMPILE --> REGISTRY[Tool Registry]
    REGISTRY --> INTERNAL[LangGraph内部调用]
    REGISTRY --> MCP[MCP tools/call]
    INTERNAL --> AUDIT[统一权限/审计/幂等]
    MCP --> AUDIT
```
