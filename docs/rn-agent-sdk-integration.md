# React Native Agent SDK 接入

## 1. SDK 负责什么

`rn-agent-sdk` 是框架无关的协议客户端，不保存业务页面状态，也不依赖 React Native、Redux 或 Zustand。它负责：

- 使用 JWT 创建、查询和审批 Run。
- 保存 `clientRequestId -> runId` 映射，重复启动时恢复已有 Run。
- 按 `sequence` 消费历史补发和实时 SSE，自动丢弃重复事件。
- App 进入后台时关闭连接，恢复前台时先补发再订阅。
- 串行保存 `lastSequence`，避免异步存储乱序覆盖游标。

服务端 Run 和事件仍是事实来源；Redux/HOC 只投影 SDK 的 `AgentSessionView` 和事件。

## 2. RNModules 适配边界

RNModules 已使用 `AppState.addEventListener('change', ...)` 和 `@hecom/storage`。接入时只需实现两个小接口：

```ts
const lifecycle: AppLifecycle = {
  current: () => normalizeAppState(AppState.currentState),
  subscribe: (listener) => {
    const subscription = AppState.addEventListener("change", (state) => {
      listener(normalizeAppState(state));
    });
    return () => subscription.remove();
  },
};

const storage: AgentSessionStorage = {
  load: (key) => AsyncStorage.get(["agent-runtime", key]),
  save: (key, value) => AsyncStorage.set(["agent-runtime", key], value),
  remove: (key) => AsyncStorage.clear(["agent-runtime", key]),
};
```

这些适配器留在 RNModules，Runtime 仓库不反向依赖 React Native。

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
