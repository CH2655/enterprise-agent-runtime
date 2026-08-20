# PaaS 元数据到 Agent Tool 的映射

## 1. 目的与边界

RNModules 已有业务对象元数据、动态页面、字段处理器和应用扩展注册机制。Agent Runtime 不复制这些 UI 能力，也不直接依赖 RN 工程；PaaS 服务端导出一个版本化、脱敏的有效元数据快照，`paas-metadata` 将快照编译为受 Tool Registry 治理的工具。

公开仓库只保存结构等价的演示快照，不保存客户对象、内部接口地址或真实权限数据。

## 2. RNModules 依据

| RNModules 能力 | 归一化快照 | Tool 行为 |
| --- | --- | --- |
| `Field.type/subType` | `type/subType` | 生成 Zod 字段类型 |
| `Field.required` | `required` | 创建工具要求必填字段 |
| `Field.hidden`、布局隐藏配置 | `hidden` | 不进入输入和输出 Schema |
| `LayoutConfig.readOnly`、计算字段 | `readOnly` | 不进入创建/更新 Schema |
| 对象字段权限结果 | `permissions.read/create/update` | 与字段配置取交集，默认拒绝 |
| `appName/metaName/action/objectId` | 对象 Action | Registry 执行对象权限校验 |
| `FieldProcessor`、应用 `setup()` 扩展 | 导出前形成有效元数据 | Agent 不重复实现客户端扩展逻辑 |
| 企业敏感字段分级 | `policy.read/write` | 明文、掩码、禁止读取及禁止写入 |

`permissions` 是 PaaS 权限服务计算后的归一化结果。编译器不猜测历史权限标志的含义，也不根据字段名称猜测敏感级别。

## 3. 合并规则

字段可读需要同时满足：

```text
PaaS 字段读权限
  AND 字段未隐藏
  AND Agent 读取策略不是 deny
```

字段可写需要同时满足：

```text
对应 create/update 字段权限
  AND 字段未隐藏、非只读、非计算字段
  AND Agent 写策略为 allow
```

对象级 Scope、对象权限、写审批和幂等不进入生成的业务参数，而由可信身份上下文和 Tool Registry 注入。模型即使伪造 `tenantId`、审批人或敏感字段，也无法通过输入 Schema 和治理链路。

## 4. 生成结果

以 `Supplier` 快照为例，编译器生成：

```text
paas_supplier_get
paas_supplier_create
paas_supplier_update
```

- `get` 只选择允许读取的字段，返回前再次掩码或删除敏感字段。
- `create` 根据 `required` 生成必填约束，系统编码和只读字段不会出现在 Schema。
- `update` 使用至少包含一个字段的严格 Patch Schema，未知、敏感和只读字段被拒绝。
- 输出携带 `metadataVersion`，便于审计工具调用时使用的能力版本。

## 5. MCP 暴露

工具必须显式声明 `exposure: ["mcp"]` 才会进入 MCP 目录。MCP Server 使用官方 SDK 注册工具，但回调只调用 `ToolRegistry.execute()`；它不持有业务执行函数，也不重新实现 Scope、对象权限、审批、幂等和审计。

stdio 示例中的环境身份只用于本地演示。生产 HTTP Transport 必须从已验证 Token 的 `authInfo` 解析租户和用户，不能接受模型参数中的身份字段。

## 6. 可验证证据

- `compiler.test.ts`：验证类型、必填、只读、敏感字段和有效元数据快照。
- `server.test.ts`：使用官方 MCP 内存传输执行真实 `tools/list`、`tools/call`，并验证内部/MCP 共用幂等结果和审计记录。
- `registry.test.ts`：验证只有显式授权工具进入 MCP 目录。
