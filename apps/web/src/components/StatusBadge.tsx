import type { RunStatus } from "../types";

const labels: Record<RunStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_input: "待补充",
  waiting_approval: "待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return <span className={`status-badge status-${status}`}>{labels[status]}</span>;
}
