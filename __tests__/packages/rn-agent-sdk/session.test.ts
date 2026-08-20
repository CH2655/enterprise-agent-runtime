import type { AgentEvent } from "@ear/agent-protocol";
import {
  AgentRunSession,
  FetchAgentTransport,
  type AgentEventStreamConnection,
  type AgentRunSnapshot,
  type AgentSessionStorage,
  type AgentTransport,
  type AppLifecycle,
  type AppLifecycleState,
  type StoredAgentSession,
} from "@ear/rn-agent-sdk";
import { describe, expect, it, vi } from "vitest";

describe("RN Agent SDK", () => {
  it("应在切后台后关闭连接并在恢复前台时补发且去重事件", async () => {
    const lifecycle = new FakeLifecycle();
    const storage = new MemorySessionStorage();
    const transport = new FakeTransport();
    const session = new AgentRunSession({
      storageKey: "tenant-a:user-1:risk-case-1",
      transport,
      storage,
      lifecycle,
      reconnectDelayMs: 5,
    });
    const sequences: number[] = [];
    session.subscribe((_view, event) => {
      if (event) sequences.push(event.sequence);
    });

    const request = {
      clientRequestId: "mobile-request-1",
      agentId: "risk-agent",
      input: { caseId: "case-1" },
    };
    await Promise.all([session.start(request), session.start(request)]);
    expect(transport.startCalls).toBe(1);
    expect(transport.streamAfter).toEqual([0]);

    transport.publish(event(1, "run.created"));
    await flush();
    lifecycle.change("background");
    expect(transport.closedStreams).toBe(1);
    transport.record(event(2, "node.started"));
    transport.record(event(3, "approval.required"));

    lifecycle.change("active");
    await waitFor(() => session.snapshot().lastSequence === 3);
    expect(transport.replayAfter).toEqual([0, 1]);
    expect(transport.streamAfter).toEqual([0, 3]);

    transport.publish(event(3, "approval.required"));
    transport.publish(event(4, "approval.completed"));
    await waitFor(() => storage.current?.lastSequence === 4);
    expect(sequences).toEqual([1, 2, 3, 4]);
    expect(transport.startCalls).toBe(1);
    session.dispose();
  });

  it("应从持久化Run恢复完整时间线而不重新创建任务", async () => {
    const lifecycle = new FakeLifecycle();
    const storage = new MemorySessionStorage({
      clientRequestId: "mobile-request-1",
      agentId: "risk-agent",
      runId: "run-1",
      lastSequence: 2,
    });
    const transport = new FakeTransport();
    transport.record(event(1, "run.created"));
    transport.record(event(2, "node.started"));
    transport.record(event(3, "run.completed"));
    const session = new AgentRunSession({
      storageKey: "tenant-a:user-1:risk-case-1",
      transport,
      storage,
      lifecycle,
    });

    await session.restore();

    expect(transport.startCalls).toBe(0);
    expect(transport.getCalls).toEqual(["run-1"]);
    expect(transport.replayAfter).toEqual([0]);
    expect(session.snapshot().lastSequence).toBe(3);
    session.dispose();
  });

  it("应拒绝用新的客户端请求覆盖已持久化的任务", async () => {
    const transport = new FakeTransport();
    const session = new AgentRunSession({
      storageKey: "tenant-a:user-1:occupied",
      transport,
      storage: new MemorySessionStorage({
        clientRequestId: "existing-request",
        agentId: "risk-agent",
        runId: "run-1",
        lastSequence: 1,
      }),
      lifecycle: new FakeLifecycle(),
    });

    await expect(
      session.start({
        clientRequestId: "new-request",
        agentId: "risk-agent",
        input: {},
      }),
    ).rejects.toThrow("storage key already belongs");
    expect(transport.startCalls).toBe(0);
    session.dispose();
  });

  it("HTTP传输应注入JWT并使用标准SSE解析器读取事件", async () => {
    const expected = event(1, "run.created");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: 1\ndata: ${JSON.stringify(expected)}\n\n`));
        controller.close();
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const transport = new FetchAgentTransport({
      baseUrl: "https://runtime.example/api/",
      getAccessToken: () => "jwt-token",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const received: AgentEvent[] = [];

    const connection = await transport.openEventStream({
      runId: "run-1",
      afterSequence: 0,
      onEvent: (item) => received.push(item),
    });
    await connection.done;

    expect(received).toEqual([expected]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://runtime.example/api/runs/run-1/events/stream?after=0",
      expect.objectContaining({
        headers: { authorization: "Bearer jwt-token", accept: "text/event-stream" },
      }),
    );
  });
});

class FakeLifecycle implements AppLifecycle {
  private state: AppLifecycleState = "active";
  private readonly listeners = new Set<(state: AppLifecycleState) => void>();

  current(): AppLifecycleState {
    return this.state;
  }

  subscribe(listener: (state: AppLifecycleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  change(state: AppLifecycleState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

class MemorySessionStorage implements AgentSessionStorage {
  current?: StoredAgentSession;

  constructor(initial?: StoredAgentSession) {
    this.current = initial;
  }

  async load(): Promise<StoredAgentSession | undefined> {
    return this.current ? { ...this.current } : undefined;
  }

  async save(_key: string, session: StoredAgentSession): Promise<void> {
    this.current = { ...session };
  }

  async remove(): Promise<void> {
    this.current = undefined;
  }
}

class FakeTransport implements AgentTransport {
  startCalls = 0;
  closedStreams = 0;
  readonly replayAfter: number[] = [];
  readonly streamAfter: number[] = [];
  readonly getCalls: string[] = [];
  private readonly events: AgentEvent[] = [];
  private currentStream?: { onEvent(event: AgentEvent): void; close(): void };

  async startRun(): Promise<AgentRunSnapshot> {
    this.startCalls += 1;
    return run();
  }

  async getRun(runId: string): Promise<AgentRunSnapshot> {
    this.getCalls.push(runId);
    return run();
  }

  async replayEvents(_runId: string, afterSequence: number): Promise<AgentEvent[]> {
    this.replayAfter.push(afterSequence);
    return this.events.filter((item) => item.sequence > afterSequence);
  }

  async openEventStream(input: {
    runId: string;
    afterSequence: number;
    onEvent(event: AgentEvent): void;
  }): Promise<AgentEventStreamConnection> {
    this.streamAfter.push(input.afterSequence);
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let closed = false;
    this.currentStream = {
      onEvent: input.onEvent,
      close: () => {
        if (closed) return;
        closed = true;
        this.closedStreams += 1;
        resolveDone();
      },
    };
    return { done, close: this.currentStream.close };
  }

  async approveRun(): Promise<AgentRunSnapshot> {
    return { ...run(), status: "completed" };
  }

  record(item: AgentEvent): void {
    this.events.push(item);
  }

  publish(item: AgentEvent): void {
    this.record(item);
    this.currentStream?.onEvent(item);
  }
}

function run(): AgentRunSnapshot {
  return { id: "run-1", agentId: "risk-agent", status: "running" };
}

function event(sequence: number, type: AgentEvent["type"]): AgentEvent {
  return {
    runId: "run-1",
    sequence,
    type,
    timestamp: new Date(2026, 7, 20, 12, 0, sequence).toISOString(),
    payload: {},
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("Condition was not met in time");
}
