import { InMemoryAgentEventStore } from "@ear/agent-protocol";
import { describe, expect, it, vi } from "vitest";

describe("InMemoryAgentEventStore", () => {
  it("应为同一运行生成连续序号并按序号补发事件", async () => {
    const store = new InMemoryAgentEventStore();
    await store.append("run-1", { type: "run.created", payload: {} });
    await store.append("run-1", { type: "node.started", nodeId: "plan", payload: {} });
    await store.append("run-1", { type: "node.progress", nodeId: "plan", payload: {} });

    expect((await store.replay("run-1", 1)).map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("应只向当前运行的订阅者推送新事件", async () => {
    const store = new InMemoryAgentEventStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe("run-1", listener);

    await store.append("run-2", { type: "run.created", payload: {} });
    await store.append("run-1", { type: "run.created", payload: { expected: true } });
    unsubscribe();
    await store.append("run-1", { type: "node.started", payload: {} });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].payload).toEqual({ expected: true });
  });
});
