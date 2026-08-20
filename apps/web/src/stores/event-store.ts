import { create } from "zustand";
import { emptyProjection, projectEvents, type EventProjection } from "../lib/event-projector";
import type { AgentEvent } from "../types";

type ConnectionStatus = "idle" | "connecting" | "live" | "reconnecting";

interface EventStore {
  runs: Record<string, EventProjection>;
  connections: Record<string, ConnectionStatus>;
  ingest(runId: string, events: AgentEvent[]): void;
  setConnection(runId: string, status: ConnectionStatus): void;
  clearRun(runId: string): void;
}

export const useEventStore = create<EventStore>((set) => ({
  runs: {},
  connections: {},
  ingest: (runId, events) => set((state) => ({
    runs: {
      ...state.runs,
      [runId]: projectEvents(state.runs[runId] ?? emptyProjection, events),
    },
  })),
  setConnection: (runId, status) => set((state) => ({
    connections: { ...state.connections, [runId]: status },
  })),
  clearRun: (runId) => set((state) => {
    const runs = { ...state.runs };
    const connections = { ...state.connections };
    delete runs[runId];
    delete connections[runId];
    return { runs, connections };
  }),
}));
