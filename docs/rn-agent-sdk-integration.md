# React Native Agent SDK 接入

## 1. SDK 负责什么

`rn-agent-sdk` 是框架无关的协议客户端，不保存业务页面状态，也不依赖 React Native、Redux 或 Zustand。它负责：

- 使用 JWT 创建、查询和审批 Run。
- 保存 `clientRequestId -> runId` 映射，重复启动时恢复已有 Run。
- 按 `sequence` 消费历史补发和实时 SSE，自动丢弃重复事件。
- App 进入后台时关闭连接，恢复前台时先补发再订阅。
- 串行保存 `lastSequence`，避免异步存储乱序覆盖游标。

服务端 Run 和事件仍是事实来源；Redux/HOC 只投影 SDK 的 `AgentSessionView` 和事件。

## 2. 跨端适配边界

SDK 不导入 React Native。RNModules 将现有 `AppState` 注入适配器，存储则通过字符串存储协议接入 AsyncStorage 或宿主封装：

```ts
const lifecycle = createReactNativeAppLifecycle(AppState);
const storage = createJsonSessionStorage(AsyncStorage, "agent-runtime");
```

若公司存储模块不是 `getItem/setItem/removeItem` 形态，只在 RNModules 内包装这三个方法。Runtime 仓库不反向依赖 React Native 或 `@hecom/storage`。

Web 可使用同一存储适配器，并选择真实浏览器生命周期或可控实验生命周期：

```ts
const lifecycle = createBrowserDocumentLifecycle(document);
const storage = createJsonSessionStorage(localStorage);
```

## 3. 会话使用

`storageKey` 必须包含租户、用户和业务入口，避免账号切换后复用另一身份的 Run。`clientRequestId` 在用户首次提交时生成并保持稳定。

```ts
const transport = new FetchAgentTransport({
  baseUrl: `${runtimeBaseUrl}/api`,
  getAccessToken: () => authManager.getAccessToken(),
});

const session = new AgentRunSession({
  storageKey: `${tenantId}:${userId}:risk:${caseId}`,
  transport,
  storage,
  lifecycle,
});

session.subscribe((view, event) => {
  dispatch(updateAgentProjection({ view, event }));
});

await session.start({
  clientRequestId,
  agentId: "risk-agent",
  input: { caseId, projectCode, supplierCode },
});
```

页面卸载时调用 `dispose()`。它只停止监听，不取消服务端 Run；重新进入页面后调用 `restore()` 即可恢复。

## 4. SSE 兼容性

默认 `FetchAgentTransport` 使用标准 `ReadableStream` 和 `eventsource-parser`。若目标 RN 网络实现不提供 `Response.body.getReader()`，应用层实现同一 `AgentTransport.openEventStream()` 接口并接入已有原生 SSE/WebSocket 能力，Session 状态机无需修改。

## 5. 可靠性边界

- 切后台/回前台不会重新调用 `startRun()`，只会补发和重连。
- 同一存储槽已有不同 `clientRequestId` 时拒绝覆盖，避免产生孤儿 Run。
- 当前只保证客户端收到创建响应后的生命周期恢复。若进程在服务端创建成功、客户端保存 `runId` 前崩溃，仍需要后续增加服务端 `clientRequestId` 唯一约束才能彻底消除重复创建窗口。

## 6. Web 生命周期实验台

工作台右上角进入“恢复实验台”。它复用同一个 `AgentRunSession` 和 `FetchAgentTransport`，调用真实 Contract Agent：

1. 新建任务时并发提交两次相同请求，验证 Session 只调用一次创建接口。
2. 等待状态进入 `waiting_approval` 后切到后台，SSE 状态变为 `paused`。
3. 在后台执行审批，使服务端产生客户端尚未收到的新事件。
4. 恢复前台，从后台游标补发并显示绿色恢复事件，最终状态进入 `completed`。

该实验覆盖协议和状态机，不替代真机上的网络、系统杀进程和厂商后台策略测试。
