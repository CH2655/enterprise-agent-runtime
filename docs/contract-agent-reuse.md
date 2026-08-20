# 合同合规 Agent 复用证明

## 1. 业务闭环

```text
合同 ID + 供应商编码
  -> 元数据生成的 paas_contract_get 读取合同档案
  -> get_contract_policy 读取付款与责任条款基线
  -> 生成可定位 Evidence
  -> 确定性规则识别预付款比例和责任上限问题
  -> 有问题时暂停等待人工审批
  -> 幂等创建合同复核任务
```

## 2. 为什么不复制风控 LangGraph

合同示例的目标是验证平台复用，而不是制造第二套复杂流程。它直接实现稳定的 `AgentDefinition`，没有复制 Risk Agent 的规划 Loop；Runtime 仍统一负责 Agent 注册、Run 状态、租户访问、审批占用、恢复入口、Evidence/Finding 保存和事件。

这证明 LangGraph 是业务 Agent 可选的编排实现，不是 Runtime 的强耦合前提。复杂风控使用动态图，固定合同规则使用轻量确定性流程，两者共享相同治理内核。

## 3. 复用点

| 能力 | 是否复用 | 说明 |
| --- | --- | --- |
| Agent Registry / Run Store | 是 | 仅注册新 `contract-agent` |
| Tool Registry | 是 | Scope、对象权限、审批、审计和幂等完全一致 |
| PaaS 元数据编译器 | 是 | 合同档案读取工具不是手写字段 Schema |
| Evidence / Finding | 是 | 使用同一持久化产物契约 |
| Approval / Recovery | 是 | 审批恢复复用稳定幂等键 |
| Event / SSE | 是 | 工作台和 RN SDK 无需新增事件协议 |
| Risk Agent LangGraph | 否 | 合同规则不需要动态补取 Loop |

## 4. 当前限制

- 合同数据、制度和写回 Gateway 是脱敏确定性实现，真实 PaaS 接口待接入。
- 合同规则目前覆盖预付款比例和责任上限，用于证明复用，不宣称完整法务审查能力。
- Web 通用任务列表、标题、时间线、Evidence 和审批可展示合同 Run；合同专属创建表单和报告指标布局尚未补齐。
