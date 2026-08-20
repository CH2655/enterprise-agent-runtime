import {
  AgentRunSession,
  FetchAgentTransport,
  createJsonSessionStorage,
  type AgentEventStreamConnection,
  type AgentRunSnapshot,
  type AgentSessionView,
  type AgentTransport,
  type AppLifecycle,
  type AppLifecycleState,
  type StartAgentRunRequest,
} from "@ear/rn-agent-sdk";
import {
  Activity,
  CheckCircle2,
  CloudDownload,
  Database,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  Smartphone,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { API_BASE, identityHeaders } from "../api";
import type { AgentEvent, DemoIdentity } from "../types";
import { StatusBadge } from "./StatusBadge";

interface TransportMetrics {
  startRequests: number;
  replayRequests: number;
  replayedEvents: number;
  streamConnections: number;
}

interface LabRuntime {
  session: AgentRunSession;
  lifecycle: SimulatedLifecycle;
  transport: MeasuredTransport;
}

const EMPTY_VIEW: AgentSessionView = { connection: "idle", lastSequence: 0 };
const EMPTY_METRICS: TransportMetrics = {
  startRequests: 0,
  replayRequests: 0,
  replayedEvents: 0,
  streamConnections: 0,
};

export function LifecycleLab({ identity }: { identity: DemoIdentity }) {
  const [runtime, setRuntime] = useState<LabRuntime>();
  const [view, setView] = useState<AgentSessionView>(EMPTY_VIEW);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [metrics, setMetrics] = useState<TransportMetrics>(EMPTY_METRICS);
  const [lifecycleState, setLifecycleState] = useState<AppLifecycleState>("active");
  const [pauseSequence, setPauseSequence] = useState<number>();
  const [pausedObserved, setPausedObserved] = useState(false);
  const [submissionAttempts, setSubmissionAttempts] = useState(0);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const lifecycle = new SimulatedLifecycle();
    const transport = new MeasuredTransport(
      new FetchAgentTransport({
        baseUrl: API_BASE,
        getHeaders: () => identityHeaders(identity),
      }),
      setMetrics,
    );
    const session = new AgentRunSession({
      storageKey: `${identity.tenantId}:${identity.userId}:contract-lifecycle-lab`,
      transport,
      storage: createJsonSessionStorage(window.localStorage, "ear.lifecycle-lab"),
      lifecycle,
      reconnectDelayMs: 750,
    });
    const unsubscribe = session.subscribe((nextView, event) => {
      setView(nextView);
      if (event) {
        setEvents((current) => mergeEvents(current, event as AgentEvent));
      }
    });
    const nextRuntime = { session, lifecycle, transport };
    setRuntime(nextRuntime);
    setView(EMPTY_VIEW);
    setEvents([]);
    setMetrics(EMPTY_METRICS);
    setLifecycleState("active");
    setPauseSequence(undefined);
    setPausedObserved(false);
    setSubmissionAttempts(0);
    setError(undefined);
    void session.restore().catch((reason) => setError(errorMessage(reason)));
    return () => {
      unsubscribe();
      session.dispose();
    };
  }, [identity.tenantId, identity.userId, identity.token]);

  const recoveredEvents = useMemo(
    () => pauseSequence === undefined ? 0 : events.filter((event) => event.sequence > pauseSequence).length,
    [events, pauseSequence],
  );

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setError(undefined);
    try {
      await action();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(undefined);
    }
  };

  const startDemo = () => runAction("start", async () => {
    if (!runtime) return;
    await runtime.session.clear();
    runtime.transport.reset();
    setEvents([]);
    setPauseSequence(undefined);
    setPausedObserved(false);
    setLifecycleState("active");
    runtime.lifecycle.change("active");
    const request: StartAgentRunRequest = {
      clientRequestId: `web-lab-${identity.tenantId}-${Date.now()}`,
      agentId: "contract-agent",
      input: {
        contractId: `CON-${new Date().toISOString().slice(11, 19).replaceAll(":", "")}`,
        supplierCode: "SUP-LIFECYCLE",
      },
    };
    setSubmissionAttempts(2);
    await Promise.all([runtime.session.start(request), runtime.session.start(request)]);
  });

  const enterBackground = () => {
    if (!runtime) return;
    setPauseSequence(view.lastSequence);
    setPausedObserved(true);
    setLifecycleState("background");
    runtime.lifecycle.change("background");
  };

  const approveInBackground = () => runAction("approve", async () => {
    if (!runtime) return;
    await runtime.session.approve();
  });

  const returnForeground = () => {
    if (!runtime) return;
    setLifecycleState("active");
    runtime.lifecycle.change("active");
  };

  const clearSession = () => runAction("clear", async () => {
    if (!runtime) return;
    await runtime.session.clear();
    runtime.transport.reset();
    setEvents([]);
    setPauseSequence(undefined);
    setPausedObserved(false);
    setSubmissionAttempts(0);
  });

  const runStatus = view.run?.status;
  const canPause = Boolean(view.run) && lifecycleState === "active";
  const canApprove = lifecycleState === "background" && runStatus === "waiting_approval";
  const canResume = lifecycleState === "background";

  return (
    <main className="lifecycle-lab">
      <header className="lab-header">
        <div>
          <span className="lab-kicker"><Smartphone size={15} /> Cross-platform Agent Client</span>
          <h1>生命周期恢复实验台</h1>
        </div>
        <div className={`lab-runtime-state lifecycle-${lifecycleState}`}>
          {lifecycleState === "active" ? <Wifi size={17} /> : <WifiOff size={17} />}
          <span>{lifecycleState === "active" ? "前台" : "后台"}</span>
        </div>
      </header>

      <section className="lab-command-bar" aria-label="生命周期操作">
        <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void startDemo()}>
          {busy === "start" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          新建验证任务
        </button>
        <button className="secondary-button" type="button" disabled={!canPause || Boolean(busy)} onClick={enterBackground}>
          <Pause size={16} /> 进入后台
        </button>
        <button className="approve-button" type="button" disabled={!canApprove || Boolean(busy)} onClick={() => void approveInBackground()}>
          {busy === "approve" ? <LoaderCircle className="spin" size={16} /> : <CheckCircle2 size={16} />}
          后台审批
        </button>
        <button className="secondary-button" type="button" disabled={!canResume || Boolean(busy)} onClick={returnForeground}>
          <Play size={16} /> 恢复前台
        </button>
        <button className="icon-button lab-reset" type="button" title="清除实验会话" disabled={Boolean(busy)} onClick={() => void clearSession()}>
          <RefreshCw size={17} />
        </button>
      </section>

      {error && <div className="lab-error">{error}</div>}

      <section className="lab-metrics" aria-label="恢复指标">
        <LabMetric icon={<Send size={18} />} label="提交 / 创建" value={`${submissionAttempts} / ${metrics.startRequests}`} tone="blue" />
        <LabMetric icon={<CloudDownload size={18} />} label="补发事件" value={String(metrics.replayedEvents)} tone="teal" />
        <LabMetric icon={<Activity size={18} />} label="恢复后事件" value={String(recoveredEvents)} tone="green" />
        <LabMetric icon={<Database size={18} />} label="当前游标" value={`#${view.lastSequence}`} tone="amber" />
      </section>

      <div className="lab-grid">
        <section className="lab-session-panel">
          <div className="section-title">
            <div><Smartphone size={19} /><h2>客户端会话</h2></div>
            {runStatus && <StatusBadge status={runStatus} />}
          </div>
          <dl className="session-facts">
            <div><dt>Run ID</dt><dd>{view.run?.id ?? "尚未创建"}</dd></div>
            <div><dt>Agent</dt><dd>{view.run?.agentId ?? "contract-agent"}</dd></div>
            <div><dt>连接状态</dt><dd><ConnectionValue status={view.connection} /></dd></div>
            <div><dt>SSE 连接</dt><dd>{metrics.streamConnections}</dd></div>
            <div><dt>补发请求</dt><dd>{metrics.replayRequests}</dd></div>
            <div><dt>后台游标</dt><dd>{pauseSequence === undefined ? "-" : `#${pauseSequence}`}</dd></div>
          </dl>
          <div className="lab-invariant-list">
            <Invariant label="并发提交收敛" passed={submissionAttempts > 0 && metrics.startRequests === 1} />
            <Invariant label="后台连接暂停" passed={pausedObserved} />
            <Invariant label="游标补偿完成" passed={pauseSequence !== undefined && recoveredEvents > 0 && lifecycleState === "active"} />
          </div>
        </section>

        <section className="lab-event-panel">
          <div className="section-title">
            <div><Activity size={19} /><h2>SDK 接收事件</h2></div>
            <span>{events.length} 条</span>
          </div>
          <div className="lab-event-list">
            {events.map((event) => (
              <div className={pauseSequence !== undefined && event.sequence > pauseSequence ? "is-recovered" : ""} key={event.sequence}>
                <span>#{event.sequence}</span>
                <strong>{eventLabel(event.type)}</strong>
                <time>{formatTime(event.timestamp)}</time>
              </div>
            ))}
            {!events.length && <div className="lab-empty">等待验证任务</div>}
          </div>
        </section>
      </div>
    </main>
  );
}

function LabMetric({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: string; tone: string }) {
  return <div className={`lab-metric lab-metric-${tone}`}><span>{icon}</span><div><small>{label}</small><strong>{value}</strong></div></div>;
}

function ConnectionValue({ status }: { status: AgentSessionView["connection"] }) {
  const label = ({ idle: "未连接", syncing: "补发中", live: "实时订阅", paused: "已暂停", reconnecting: "正在重连" } as const)[status];
  return <span className={`connection-value connection-value-${status}`}><i />{label}</span>;
}

function Invariant({ label, passed }: { label: string; passed: boolean }) {
  return <div className={passed ? "passed" : "pending"}>{passed ? <CheckCircle2 size={15} /> : <span />}{label}</div>;
}

class SimulatedLifecycle implements AppLifecycle {
  private state: AppLifecycleState = "active";
  private readonly listeners = new Set<(state: AppLifecycleState) => void>();

  current(): AppLifecycleState { return this.state; }
  subscribe(listener: (state: AppLifecycleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  change(state: AppLifecycleState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

class MeasuredTransport implements AgentTransport {
  private metrics = { ...EMPTY_METRICS };

  constructor(
    private readonly inner: AgentTransport,
    private readonly onMetrics: (metrics: TransportMetrics) => void,
  ) {}

  async startRun(request: Omit<StartAgentRunRequest, "clientRequestId">): Promise<AgentRunSnapshot> {
    this.update({ startRequests: this.metrics.startRequests + 1 });
    return this.inner.startRun(request);
  }

  getRun(runId: string): Promise<AgentRunSnapshot> { return this.inner.getRun(runId); }

  async replayEvents(runId: string, afterSequence: number) {
    this.update({ replayRequests: this.metrics.replayRequests + 1 });
    const events = await this.inner.replayEvents(runId, afterSequence);
    this.update({ replayedEvents: this.metrics.replayedEvents + events.length });
    return events;
  }

  async openEventStream(input: Parameters<AgentTransport["openEventStream"]>[0]): Promise<AgentEventStreamConnection> {
    this.update({ streamConnections: this.metrics.streamConnections + 1 });
    return this.inner.openEventStream(input);
  }

  approveRun(runId: string): Promise<AgentRunSnapshot> { return this.inner.approveRun(runId); }

  reset(): void {
    this.metrics = { ...EMPTY_METRICS };
    this.onMetrics(this.metrics);
  }

  private update(patch: Partial<TransportMetrics>): void {
    this.metrics = { ...this.metrics, ...patch };
    this.onMetrics(this.metrics);
  }
}

function mergeEvents(current: AgentEvent[], incoming: AgentEvent): AgentEvent[] {
  const events = new Map(current.map((event) => [event.sequence, event]));
  events.set(incoming.sequence, incoming);
  return [...events.values()].sort((left, right) => left.sequence - right.sequence);
}

function eventLabel(type: string): string {
  return ({
    "run.created": "任务创建",
    "node.started": "节点开始",
    "tool.started": "工具调用",
    "tool.completed": "工具完成",
    "evidence.added": "证据登记",
    "approval.required": "等待审批",
    "approval.completed": "审批完成",
    "run.completed": "任务完成",
  } as Record<string, string>)[type] ?? type;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
