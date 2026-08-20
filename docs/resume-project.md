# 简历项目描述

以下版本均以当前代码和评测为边界。岗位不同只调整强调顺序，不改变事实。

## 1. AI 全栈工程师版本

### 企业 Agent Runtime 与 PaaS 智能业务执行平台

技术栈：TypeScript、Fastify、React、LangGraph、PostgreSQL、Qdrant、MCP、Zod、SSE、Docker

- 独立设计并实现面向企业 PaaS 的多租户 Agent Runtime，以项目风控/供应商尽调为主业务，贯通动态规划、受控工具调用、Evidence/Finding、人工审批和幂等业务写回，并通过合同合规 Agent 验证 Runtime 跨业务复用。
- 基于 LangGraph 实现 `plan -> collect -> evaluate -> replan` 受约束动态 Loop，将模型决策与确定性控制面分离；通过工具白名单、三轮上限、预算、Zod 结构化校验和 Evidence 引用守卫限制幻觉与非法计划。
- 建设 Tool Registry 治理内核，统一处理输入输出 Schema、JWT Scope、对象权限、超时、审计、审批凭据和幂等键；从脱敏 PaaS 元数据编译 get/create/update Tool Schema，并通过官方 MCP SDK 复用同一执行入口。
- 使用 PostgreSQL 持久化 Run、checkpoint、事件、审批与审计，使用 sequence 事件日志支持 SSE 断线补发；针对并发审批和“下游成功/状态回写失败”故障窗口实现恢复与最多一次受测副作用。
- 搭建 PostgreSQL Outbox + Qdrant 的多租户知识检索链路，Evidence 保存文档版本与原文定位；构建百炼真实模型三轮 30/20/10 合成评测，租户泄漏和重复副作用均为 0，P95 均值 7.11s，并将引用准确率从 78.38% 回归至 100%。

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

这是一个面向企业 PaaS 的 Agent 执行与治理平台，首个业务是供应商准入尽调。与聊天机器人不同，它需要受控读取项目、供应商、信用、流水和制度数据，生成带原文引用的风险结论，等待人工审批后再幂等写回整改任务。平台层实现了 Run/checkpoint、事件回放、Tool Registry、权限审计、Evidence、审批和幂等；业务层有动态风控 Agent 和轻量合同 Agent；客户端有 React 工作台及框架无关的 Web/RN SDK。项目还通过真实百炼、PostgreSQL 和 Qdrant 建立了可追溯评测，既验证质量，也主动暴露并修复了“把制度条件误当案件事实”的问题。
