import type { AgentEvent, RunStatus } from "../types";

export interface ProjectedNode {
  id: string;
  status: "running" | "completed" | "failed";
  lastSequence: number;
  message?: string;
}

export interface EventProjection {
  events: AgentEvent[];
  lastSequence: number;
  nodes: Record<string, ProjectedNode>;
  terminalStatus?: Extract<RunStatus, "completed" | "failed" | "cancelled">;
}

export const emptyProjection: EventProjection = {
  events: [],
  lastSequence: 0,
  nodes: {},
};

export function projectEvents(
  current: EventProjection | undefined,
  incoming: AgentEvent[],
): EventProjection {
  const bySequence = new Map<number, AgentEvent>();
  for (const event of current?.events ?? []) bySequence.set(event.sequence, event);
  for (const event of incoming) {
    if (!bySequence.has(event.sequence)) bySequence.set(event.sequence, event);
  }
  const events = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  const nodes: Record<string, ProjectedNode> = {};
  let terminalStatus: EventProjection["terminalStatus"];
  for (const event of events) {
    if (event.nodeId) {
      if (event.type === "node.started") {
        for (const node of Object.values(nodes)) {
          if (node.status === "running" && node.id !== event.nodeId) {
            node.status = "completed";
          }
        }
      }
      const previous = nodes[event.nodeId];
      const status = event.type === "node.failed" || event.type === "tool.failed"
        ? "failed"
        : event.type === "node.started"
          ? "running"
          : previous?.status ?? "completed";
      nodes[event.nodeId] = {
        id: event.nodeId,
        status,
        lastSequence: event.sequence,
        ...(typeof event.payload.message === "string"
          ? { message: event.payload.message }
          : previous?.message
            ? { message: previous.message }
            : {}),
      };
    }
    if (event.type === "approval.required" || event.type === "run.waiting_input") {
      for (const node of Object.values(nodes)) {
        if (node.status === "running") node.status = "completed";
      }
    }
    if (event.type === "run.completed") {
      terminalStatus = "completed";
      for (const node of Object.values(nodes)) {
        if (node.status === "running") node.status = "completed";
      }
    }
    if (event.type === "run.failed") terminalStatus = "failed";
  }
  return {
    events,
    lastSequence: events.at(-1)?.sequence ?? 0,
    nodes,
    ...(terminalStatus ? { terminalStatus } : {}),
  };
}
