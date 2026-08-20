import type { AgentEvent } from "@ear/agent-protocol";
import type { AgentRunStatus } from "@ear/domain";
import { createParser } from "eventsource-parser";

export interface AgentRunSnapshot {
  id: string;
  agentId: string;
  status: AgentRunStatus;
  [key: string]: unknown;
}

export interface StartAgentRunRequest {
  clientRequestId: string;
  agentId: string;
  input: unknown;
}

export interface AgentEventStreamConnection {
  done: Promise<void>;
  close(): void;
}

export interface AgentTransport {
  startRun(request: Omit<StartAgentRunRequest, "clientRequestId">): Promise<AgentRunSnapshot>;
  getRun(runId: string): Promise<AgentRunSnapshot>;
  replayEvents(runId: string, afterSequence: number): Promise<AgentEvent[]>;
  openEventStream(input: {
    runId: string;
    afterSequence: number;
    onEvent(event: AgentEvent): void;
  }): Promise<AgentEventStreamConnection>;
  approveRun(runId: string): Promise<AgentRunSnapshot>;
}

export interface StoredAgentSession {
  clientRequestId: string;
  agentId: string;
  runId: string;
  lastSequence: number;
}

export interface AgentSessionStorage {
  load(key: string): Promise<StoredAgentSession | undefined>;
  save(key: string, session: StoredAgentSession): Promise<void>;
  remove(key: string): Promise<void>;
}

export type AppLifecycleState = "active" | "inactive" | "background";

export interface AppLifecycle {
  current(): AppLifecycleState;
  subscribe(listener: (state: AppLifecycleState) => void): () => void;
}

export interface ReactNativeAppStateLike {
  currentState: string | null;
  addEventListener(
    type: "change",
    listener: (state: string) => void,
  ): { remove(): void };
}

export interface BrowserDocumentLike {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface StringStorageLike {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export function createReactNativeAppLifecycle(appState: ReactNativeAppStateLike): AppLifecycle {
  return {
    current: () => normalizeLifecycleState(appState.currentState),
    subscribe(listener) {
      const subscription = appState.addEventListener("change", (state) => {
        listener(normalizeLifecycleState(state));
      });
      return () => subscription.remove();
    },
  };
}

export function createBrowserDocumentLifecycle(document: BrowserDocumentLike): AppLifecycle {
  const current = (): AppLifecycleState => document.visibilityState === "visible" ? "active" : "background";
  return {
    current,
    subscribe(listener) {
      const onVisibilityChange = () => listener(current());
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => document.removeEventListener("visibilitychange", onVisibilityChange);
    },
  };
}

export function createJsonSessionStorage(
  storage: StringStorageLike,
  namespace = "ear.agent-session",
): AgentSessionStorage {
  const namespacedKey = (key: string) => `${namespace}:${key}`;
  return {
    async load(key) {
      const raw = await storage.getItem(namespacedKey(key));
      if (!raw) return undefined;
      try {
        const parsed = JSON.parse(raw) as unknown;
        return isStoredAgentSession(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    async save(key, session) {
      await storage.setItem(namespacedKey(key), JSON.stringify(session));
    },
    async remove(key) {
      await storage.removeItem(namespacedKey(key));
    },
  };
}

export type AgentConnectionStatus = "idle" | "syncing" | "live" | "paused" | "reconnecting";

export interface AgentSessionView {
  run?: AgentRunSnapshot;
  lastSequence: number;
  connection: AgentConnectionStatus;
}

export interface AgentRunSessionOptions {
  storageKey: string;
  transport: AgentTransport;
  storage: AgentSessionStorage;
  lifecycle: AppLifecycle;
  reconnectDelayMs?: number;
}

export class AgentRunSession {
  private readonly listeners = new Set<(view: AgentSessionView, event?: AgentEvent) => void>();
  private view: AgentSessionView = { lastSequence: 0, connection: "idle" };
  private stored?: StoredAgentSession;
  private connection?: AgentEventStreamConnection;
  private generation = 0;
  private disposed = false;
  private startPromise?: Promise<AgentRunSnapshot>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private readonly unsubscribeLifecycle: () => void;

  constructor(private readonly options: AgentRunSessionOptions) {
    this.unsubscribeLifecycle = options.lifecycle.subscribe((state) => {
      if (state === "active") void this.synchronize(false);
      else this.pause();
    });
  }

  snapshot(): AgentSessionView {
    return { ...this.view };
  }

  subscribe(listener: (view: AgentSessionView, event?: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async start(request: StartAgentRunRequest): Promise<AgentRunSnapshot> {
    if (this.disposed) throw new Error("AgentRunSession is disposed");
    if (this.startPromise) return this.startPromise;
    if (this.stored && this.stored.clientRequestId !== request.clientRequestId) {
      throw new Error("This AgentRunSession already owns another client request");
    }
    this.startPromise = this.startOrRestore(request).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async restore(): Promise<AgentRunSnapshot | undefined> {
    if (this.disposed) throw new Error("AgentRunSession is disposed");
    const stored = await this.options.storage.load(this.options.storageKey);
    if (!stored) return undefined;
    this.stored = stored;
    this.view = {
      run: await this.options.transport.getRun(stored.runId),
      lastSequence: 0,
      connection: "idle",
    };
    this.notify();
    if (this.options.lifecycle.current() === "active") await this.synchronize(true);
    return this.view.run;
  }

  async approve(): Promise<AgentRunSnapshot> {
    if (!this.stored) throw new Error("No Agent Run is attached");
    const run = await this.options.transport.approveRun(this.stored.runId);
    this.view = { ...this.view, run };
    this.notify();
    return run;
  }

  async clear(): Promise<void> {
    this.pause();
    this.stored = undefined;
    this.view = { lastSequence: 0, connection: "idle" };
    await this.options.storage.remove(this.options.storageKey);
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.unsubscribeLifecycle();
    this.listeners.clear();
  }

  private async startOrRestore(request: StartAgentRunRequest): Promise<AgentRunSnapshot> {
    const persisted = await this.options.storage.load(this.options.storageKey);
    if (persisted?.clientRequestId === request.clientRequestId) {
      const restored = await this.restore();
      if (!restored) throw new Error("Stored Agent session disappeared during restore");
      return restored;
    }
    if (persisted) {
      throw new Error("The storage key already belongs to another client request");
    }
    const run = await this.options.transport.startRun({ agentId: request.agentId, input: request.input });
    this.stored = {
      clientRequestId: request.clientRequestId,
      agentId: request.agentId,
      runId: run.id,
      lastSequence: 0,
    };
    this.view = { run, lastSequence: 0, connection: "idle" };
    await this.options.storage.save(this.options.storageKey, this.stored);
    this.notify();
    if (this.options.lifecycle.current() === "active") await this.synchronize(false);
    return run;
  }

  private async synchronize(fullReplay: boolean): Promise<void> {
    if (this.disposed || !this.stored || this.options.lifecycle.current() !== "active") return;
    const generation = ++this.generation;
    this.closeConnection();
    this.setConnection("syncing");
    try {
      const afterSequence = fullReplay ? 0 : this.view.lastSequence;
      const replayed = await this.options.transport.replayEvents(this.stored.runId, afterSequence);
      if (!this.isCurrent(generation)) return;
      for (const event of replayed.sort((left, right) => left.sequence - right.sequence)) {
        this.ingest(event);
      }
      const connection = await this.options.transport.openEventStream({
        runId: this.stored.runId,
        afterSequence: this.view.lastSequence,
        onEvent: (event) => this.ingest(event),
      });
      if (!this.isCurrent(generation)) {
        connection.close();
        return;
      }
      this.connection = connection;
      this.setConnection("live");
      void connection.done.then(
        () => this.scheduleReconnect(generation),
        () => this.scheduleReconnect(generation),
      );
    } catch {
      this.scheduleReconnect(generation);
    }
  }

  private ingest(event: AgentEvent): void {
    if (!this.stored || event.runId !== this.stored.runId) return;
    if (event.sequence <= this.view.lastSequence) return;
    const status = runStatusFromEvent(event);
    this.view = {
      ...this.view,
      lastSequence: event.sequence,
      run: status && this.view.run ? { ...this.view.run, status } : this.view.run,
    };
    this.stored = { ...this.stored, lastSequence: event.sequence };
    const snapshot = this.stored;
    this.persistenceQueue = this.persistenceQueue
      .catch(() => undefined)
      .then(() => this.options.storage.save(this.options.storageKey, snapshot))
      .catch(() => undefined);
    this.notify(event);
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isCurrent(generation)) return;
    this.closeConnection();
    this.setConnection("reconnecting");
    this.reconnectTimer = setTimeout(
      () => void this.synchronize(false),
      this.options.reconnectDelayMs ?? 1_000,
    );
  }

  private pause(): void {
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.closeConnection();
    if (this.stored && !this.disposed) this.setConnection("paused");
  }

  private closeConnection(): void {
    this.connection?.close();
    this.connection = undefined;
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation && this.options.lifecycle.current() === "active";
  }

  private setConnection(connection: AgentConnectionStatus): void {
    this.view = { ...this.view, connection };
    this.notify();
  }

  private notify(event?: AgentEvent): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot, event);
  }
}

export interface FetchAgentTransportOptions {
  baseUrl: string;
  getAccessToken?(): string | Promise<string>;
  getHeaders?(): Record<string, string> | Promise<Record<string, string>>;
  fetch?: typeof fetch;
  maxSseBufferSize?: number;
}

export class FetchAgentTransport implements AgentTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FetchAgentTransportOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  startRun(request: Omit<StartAgentRunRequest, "clientRequestId">): Promise<AgentRunSnapshot> {
    return this.request("/runs?mode=async", { method: "POST", body: JSON.stringify(request) });
  }

  getRun(runId: string): Promise<AgentRunSnapshot> {
    return this.request(`/runs/${encodeURIComponent(runId)}`);
  }

  replayEvents(runId: string, afterSequence: number): Promise<AgentEvent[]> {
    return this.request(`/runs/${encodeURIComponent(runId)}/events?after=${afterSequence}`);
  }

  approveRun(runId: string): Promise<AgentRunSnapshot> {
    return this.request(`/runs/${encodeURIComponent(runId)}/approve`, { method: "POST" });
  }

  async openEventStream(input: {
    runId: string;
    afterSequence: number;
    onEvent(event: AgentEvent): void;
  }): Promise<AgentEventStreamConnection> {
    const controller = new AbortController();
    const authHeaders = await this.authHeaders();
    const response = await this.fetchImpl(
      this.url(`/runs/${encodeURIComponent(input.runId)}/events/stream?after=${input.afterSequence}`),
      {
        headers: { ...authHeaders, accept: "text/event-stream" },
        signal: controller.signal,
      },
    );
    if (!response.ok || !response.body) throw await responseError(response);
    const parser = createParser({
      maxBufferSize: this.options.maxSseBufferSize ?? 256_000,
      onEvent: ({ data }) => input.onEvent(JSON.parse(data) as AgentEvent),
    });
    const done = consumeBody(response.body, parser.feed, controller.signal);
    return { done, close: () => controller.abort() };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const authHeaders = await this.authHeaders();
    const response = await this.fetchImpl(this.url(path), {
      ...init,
      headers: {
        ...authHeaders,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<T>;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    if (this.options.getHeaders) return this.options.getHeaders();
    if (this.options.getAccessToken) {
      return { authorization: `Bearer ${await this.options.getAccessToken()}` };
    }
    throw new Error("FetchAgentTransport requires getAccessToken or getHeaders");
  }
}

function normalizeLifecycleState(state: string | null): AppLifecycleState {
  if (state === "active") return "active";
  if (state === "inactive") return "inactive";
  return "background";
}

function isStoredAgentSession(value: unknown): value is StoredAgentSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<StoredAgentSession>;
  return typeof session.clientRequestId === "string"
    && session.clientRequestId.length > 0
    && typeof session.agentId === "string"
    && session.agentId.length > 0
    && typeof session.runId === "string"
    && session.runId.length > 0
    && typeof session.lastSequence === "number"
    && Number.isInteger(session.lastSequence)
    && session.lastSequence >= 0;
}

function runStatusFromEvent(event: AgentEvent): AgentRunStatus | undefined {
  if (event.type === "approval.required") return "waiting_approval";
  if (event.type === "run.waiting_input") return "waiting_input";
  if (event.type === "run.completed") return "completed";
  if (event.type === "run.failed") return "failed";
  if (event.type === "run.created" || event.type === "node.started") return "running";
  return undefined;
}

async function consumeBody(
  body: ReadableStream<Uint8Array>,
  feed: (chunk: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      feed(decoder.decode(value, { stream: true }));
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    reader.releaseLock();
  }
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => undefined)) as
    | { message?: string; error?: string }
    | undefined;
  return new Error(body?.message ?? body?.error ?? `Request failed (${response.status})`);
}
