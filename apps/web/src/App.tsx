import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  ChevronDown,
  CircleUserRound,
  FileSearch,
  ListFilter,
  Menu,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listRuns } from "./api";
import { CreateRunDialog } from "./components/CreateRunDialog";
import { RunDetail } from "./components/RunDetail";
import { StatusBadge } from "./components/StatusBadge";
import { presentRun, type AgentRunSummary, type DemoIdentity, type RunStatus } from "./types";

const STATUS_FILTERS: Array<{ label: string; value?: RunStatus }> = [
  { label: "全部" },
  { label: "待审批", value: "waiting_approval" },
  { label: "执行中", value: "running" },
  { label: "待补充", value: "waiting_input" },
  { label: "已完成", value: "completed" },
];

export function App() {
  const queryClient = useQueryClient();
  const [identity, setIdentity] = useState<DemoIdentity>(readIdentity);
  const [status, setStatus] = useState<RunStatus | undefined>();
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(runIdFromLocation);
  const [createOpen, setCreateOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const runsQuery = useQuery({
    queryKey: ["runs", identity.tenantId, status ?? "all"],
    queryFn: () => listRuns(identity, status),
  });

  useEffect(() => {
    const onPopState = () => setSelectedRunId(runIdFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!selectedRunId && runsQuery.data?.[0]) selectRun(runsQuery.data[0].id, false);
  }, [runsQuery.data, selectedRunId]);

  const updateIdentity = (tenantId: string) => {
    const next = {
      tenantId,
      userId: tenantId === "tenant-a" ? "reviewer-a" : "reviewer-b",
    };
    localStorage.setItem("ear.demoIdentity", JSON.stringify(next));
    setIdentity(next);
    setSelectedRunId(undefined);
    window.history.replaceState({}, "", "/");
    void queryClient.invalidateQueries();
  };

  const selectRun = (runId: string, push = true) => {
    setSelectedRunId(runId);
    setSidebarOpen(false);
    if (push) window.history.pushState({}, "", `/runs/${runId}`);
    else window.history.replaceState({}, "", `/runs/${runId}`);
  };

  const activeCount = useMemo(
    () => runsQuery.data?.filter((run) => ["running", "waiting_approval"].includes(run.status)).length ?? 0,
    [runsQuery.data],
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <button
            className="icon-button mobile-only"
            type="button"
            title="任务列表"
            onClick={() => setSidebarOpen((open) => !open)}
          >
            {sidebarOpen ? <X size={19} /> : <Menu size={19} />}
          </button>
          <div className="brand-mark"><ShieldCheck size={22} /></div>
          <div>
            <strong>Enterprise Agent Runtime</strong>
            <span>项目风控工作台</span>
          </div>
        </div>
        <div className="topbar-actions">
          <div className="runtime-health" title="Runtime 连接正常">
            <span className="health-dot" /> Runtime Online
          </div>
          <label className="tenant-select">
            <CircleUserRound size={17} />
            <select
              aria-label="当前租户"
              value={identity.tenantId}
              onChange={(event) => updateIdentity(event.target.value)}
            >
              <option value="tenant-a">华东建设集团</option>
              <option value="tenant-b">北辰工程公司</option>
            </select>
            <ChevronDown size={15} />
          </label>
          <button className="primary-button" type="button" onClick={() => setCreateOpen(true)}>
            <Plus size={17} /> 新建尽调
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className={`task-sidebar ${sidebarOpen ? "is-open" : ""}`}>
          <div className="sidebar-heading">
            <div>
              <h2>尽调任务</h2>
              <p>{activeCount} 个任务需要跟进</p>
            </div>
            <ListFilter size={18} />
          </div>
          <div className="status-tabs" role="tablist" aria-label="任务状态">
            {STATUS_FILTERS.map((item) => (
              <button
                key={item.label}
                className={status === item.value ? "active" : ""}
                type="button"
                role="tab"
                aria-selected={status === item.value}
                onClick={() => setStatus(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="task-list">
            {runsQuery.isLoading && <TaskListSkeleton />}
            {runsQuery.isError && (
              <div className="inline-error">{runsQuery.error.message}</div>
            )}
            {runsQuery.data?.map((run) => (
              <TaskItem
                key={run.id}
                run={run}
                selected={run.id === selectedRunId}
                onSelect={() => selectRun(run.id)}
              />
            ))}
            {runsQuery.data?.length === 0 && (
              <div className="empty-list">
                <FileSearch size={26} />
                <strong>暂无匹配任务</strong>
              </div>
            )}
          </div>
        </aside>

        <main className="detail-stage">
          {selectedRunId ? (
            <RunDetail runId={selectedRunId} identity={identity} />
          ) : (
            <div className="blank-state">
              <Bot size={34} />
              <h2>选择一项尽调任务</h2>
              <p>风险结论、证据与执行时间线将在这里呈现。</p>
            </div>
          )}
        </main>
      </div>

      <CreateRunDialog
        open={createOpen}
        identity={identity}
        onClose={() => setCreateOpen(false)}
        onCreated={(runId) => {
          setCreateOpen(false);
          selectRun(runId);
        }}
      />
    </div>
  );
}

function TaskItem({
  run,
  selected,
  onSelect,
}: {
  run: AgentRunSummary;
  selected: boolean;
  onSelect(): void;
}) {
  const presentation = presentRun(run);
  return (
    <button className={`task-item ${selected ? "selected" : ""}`} type="button" onClick={onSelect}>
      <div className="task-item-top">
        <strong>{presentation.title}</strong>
        <StatusBadge status={run.status} />
      </div>
      <div className="task-parties">
        <span>{presentation.parties[0]}</span>
        <span>{presentation.parties[1]}</span>
      </div>
      <div className="task-item-bottom">
        <span>{formatRelativeTime(run.updatedAt)}</span>
        <span>{run.summary.evidenceCount} 证据 · {run.summary.findingCount} 发现</span>
      </div>
    </button>
  );
}

function TaskListSkeleton() {
  return (
    <div className="task-skeleton" aria-label="加载任务">
      <span /><span /><span />
    </div>
  );
}

function runIdFromLocation(): string | undefined {
  const match = /^\/runs\/([0-9a-f-]+)$/i.exec(window.location.pathname);
  return match?.[1];
}

function readIdentity(): DemoIdentity {
  try {
    const stored = JSON.parse(localStorage.getItem("ear.demoIdentity") ?? "null") as DemoIdentity | null;
    if (stored?.tenantId && stored.userId) return stored;
  } catch {
    // Ignore invalid local demo state.
  }
  return { tenantId: "tenant-a", userId: "reviewer-a" };
}

function formatRelativeTime(value: string): string {
  const delta = Date.now() - new Date(value).getTime();
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}
