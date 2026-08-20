# 简历项目描述

以下版本均以当前代码和评测为边界。岗位不同只调整强调顺序，不改变事实。

## 1. AI 全栈工程师版本

### 企业级多租户 Agent Runtime 与智能风控执行平台

技术栈：TypeScript、Fastify、React、LangGraph、PostgreSQL、Qdrant、MCP、Zod、SSE、Docker

- 独立设计并实现面向企业 PaaS 的多租户 Agent Runtime，以供应商准入/项目风控为标杆场景：受控读取项目、供应商、企业风险、流水及制度知识，输出带证据的风险结论，经人工审批后幂等创建整改任务；新增合同合规 Agent 时复用同一运行内核，验证平台跨业务扩展能力。
- **受控 Agent 执行：**基于 LangGraph 实现 `plan -> collect -> evaluate -> replan` 有界动态 Loop，将大模型限定为“候选计划与结论生成器”，由确定性控制面执行工具白名单、参数构造、三轮/预算上限、Zod Schema 及 Evidence 引用校验，阻断越权工具、非法计划和无证据结论。
- **可信多租户 RAG：**以 PostgreSQL 管理制度版本、Chunk、权限标签和 Outbox，异步写入 Qdrant 可重建向量索引；检索时按可信租户与权限过滤，并回查活动文档版本，Evidence 保留文档版本、章节、Chunk 和行号定位。真实模型首轮评测发现“制度条件被误判为案件事实”，增加事实边界守卫后，限定 E2 数据集引用准确率由 78.38% 提升至 100%。
- **可靠审批与业务写回：**持久化 Run、checkpoint、顺序事件、审批、工具审计和幂等记录；通过审批状态竞争控制、稳定幂等键和启动恢复，处理重复审批及“下游已成功、Run 状态未落库”的故障窗口；Web/RN 客户端基于 SSE sequence 游标补发并去重，保证断线与前后台切换后状态连续。
- **平台治理与工程验证：**建设 Tool Registry，统一输入输出 Schema、JWT Scope、对象权限、超时、审计、审批凭据和幂等策略，并从脱敏 PaaS 元数据编译工具、通过官方 MCP SDK 暴露同一治理入口；完成百炼 + PostgreSQL + Qdrant 三轮 E2 评测（每轮 30 个检索问题、20 个风控案件、10 个越权攻击），租户泄漏与重复副作用均为 0，Agent P95 均值 7.11s。

项目边界：公开项目使用脱敏/Mock PaaS Gateway 与合成数据；上述准确率是限定评测集结果，不代表生产 SLA。

## 2. AI 前端工程师版本

### 企业 Agent 人机协作工作台与跨端运行 SDK

技术栈：React、TypeScript、TanStack Query、Zustand、Vite、SSE、React Native Adapter、Fastify

- 负责企业风控 Agent 工作台与交互协议设计，完成任务列表、URL Run 恢复、动态执行时间线、Finding/Evidence 引用展开、审批预览与写回结果，支持 Risk/Contract 两类 Agent 共用页面投影。
- 将服务端 Run 快照、实时事件与页面临时状态分层：TanStack Query 管理服务端事实，Zustand 维护 SSE sequence 投影，按序合并历史补发与实时事件，避免重复、乱序和完成态回退。
- 抽象框架无关 Agent Client Core，封装 JWT/Demo Transport、标准 SSE 解析、游标持久化、断线重连、生命周期暂停恢复和并发启动收敛；通过薄适配器接入浏览器 visibility、RN AppState 与宿主存储，不绑定 React/Redux/Zustand。
- 实现可视化生命周期实验台，使用真实 Contract Agent 验证双提交仅一次创建、后台断连、后台审批和前台按游标补发；实测事件由 `#9` 补偿至 `#13`，并完成 1440px/390px 响应式和溢出检查。
- 与后端共同建立 Evidence、Approval、Agent Event 和错误状态契约，自动化覆盖事件去重、刷新恢复、跨租户访问和 RN 适配器边界，降低 Web/RN 重复实现协议逻辑的成本。

项目边界：RN 侧完成 AppState/存储适配器契约，未宣称已完成旧业务 App 真机系统杀进程测试。

## 3. 英文版本

### Enterprise Agent Runtime and PaaS Execution Platform

Tech: TypeScript, Fastify, React, LangGraph, PostgreSQL, Qdrant, MCP, Zod, SSE, Docker

- Designed and implemented a multi-tenant enterprise Agent Runtime for supplier due diligence, covering constrained planning, governed tool execution, traceable Evidence/Findings, human approval, and idempotent write-back; validated reuse with a second contract-compliance Agent.
- Built a bounded `plan -> collect -> evaluate -> replan` workflow with LangGraph and separated model-generated candidates from deterministic controls through tool allowlists, iteration/budget limits, structured Zod validation, and evidence-reference guards.
- Developed a Tool Registry for schema validation, JWT scopes, object-level authorization, timeouts, audit, approval credentials, and idempotency; compiled tools from sanitized PaaS metadata and exposed the same governed execution path through the official MCP SDK.
- Implemented PostgreSQL-backed runs, checkpoints, ordered event logs, approvals, and recovery, plus cursor-based SSE replay for Web/RN clients and fault-tested at-most-once side effects under the defined idempotency contract.
- Established a three-run Bailian/PostgreSQL/Qdrant evaluation on scoped synthetic datasets (30 retrieval questions, 20 cases, and 10 tenant attacks per run), recording zero tenant leaks/duplicate side effects, 7.11s mean P95 latency, and improving citation accuracy from 78.38% to 100% after fact-boundary guards.

Scope note: quality numbers are from domain-scoped synthetic evaluation data and are not production SLA claims.

## 4. 一分钟项目介绍

这是一个面向企业 PaaS 的多租户 Agent 执行与治理平台，首个标杆业务是供应商准入和项目风控。它不是给用户聊天，而是受控读取项目、供应商、企业风险、流水和制度知识，形成带原文定位的风险结论，经人工审批后创建整改任务。

项目最核心的设计原则是：模型负责生成候选计划和判断，确定性代码掌握执行权。为此我实现了三条关键链路：第一，LangGraph 有界动态 Loop 与 Tool Registry，控制工具、权限、预算和输出；第二，PostgreSQL Outbox + Qdrant 的版本化多租户 RAG，把每条 Finding 追溯到 Evidence 原文；第三，Run/checkpoint、审批竞争、幂等写回和 SSE 事件补发，使流程在重复操作、服务重启及客户端断线后仍可恢复。

为了证明这不是单场景 Demo，我又接入了合同合规 Agent，并让 Web/RN 共用同一 Run/Event 协议。最后用真实百炼模型、PostgreSQL 和 Qdrant 做三轮 E2 评测；评测曾发现模型把制度规范误当成案件事实，我通过事实边界守卫和回归门禁把限定数据集的引用准确率从 78.38% 提升到 100%。

## 5. 面试展开主线

面试时不要按模块罗列功能，围绕下面三个问题展开：

1. **模型输出为什么敢执行？** 讲 LangGraph 有界 Loop、Tool Registry、可信上下文、Schema、Evidence Guard，以及“模型提议、代码裁决”的边界。
2. **RAG 结果为什么可信且不串租户？** 讲文档版本、权限标签、PostgreSQL Outbox、Qdrant 过滤、活动版本回查、Evidence locator，以及制度规范/案件事实边界。
3. **审批和写回失败后为什么不重复？** 讲 checkpoint、审批竞争、稳定幂等键、故障窗口恢复、sequence 事件日志与客户端游标补发。

平台级能力作为第四层证明：Risk Agent 与 Contract Agent 只实现各自的计划、工具和规则，复用 Run、Event、Evidence、Approval、Tool Registry、MCP 和客户端协议；这说明抽象边界经过第二业务验证，而不是预先设计出来的空壳。
