import { z } from "zod";

export const AgentEventTypeSchema = z.enum([
  "run.created",
  "node.started",
  "node.progress",
  "plan.created",
  "plan.rejected",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "evidence.added",
  "approval.required",
  "approval.completed",
  "node.failed",
  "run.completed",
  "run.failed",
  "run.waiting_input",
]);

export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

export interface AgentEvent<TPayload = unknown> {
  runId: string;
  sequence: number;
  type: AgentEventType;
  nodeId?: string;
  timestamp: string;
  payload: TPayload;
}

export type NewAgentEvent<TPayload = unknown> = Omit<
  AgentEvent<TPayload>,
  "runId" | "sequence" | "timestamp"
>;

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentEventStore {
  append<TPayload>(runId: string, input: NewAgentEvent<TPayload>): Promise<AgentEvent<TPayload>>;
  replay(runId: string, afterSequence?: number): Promise<AgentEvent[]>;
  subscribe(runId: string, listener: AgentEventListener): () => void;
}

export class InMemoryAgentEventStore implements AgentEventStore {
  private readonly eventsByRun = new Map<string, AgentEvent[]>();
  private readonly listenersByRun = new Map<string, Set<AgentEventListener>>();

  async append<TPayload>(
    runId: string,
    input: NewAgentEvent<TPayload>,
  ): Promise<AgentEvent<TPayload>> {
    const events = this.eventsByRun.get(runId) ?? [];
    const event: AgentEvent<TPayload> = {
      ...input,
      runId,
      sequence: (events.at(-1)?.sequence ?? 0) + 1,
      timestamp: new Date().toISOString(),
    };
    events.push(event as AgentEvent);
    this.eventsByRun.set(runId, events);
    for (const listener of this.listenersByRun.get(runId) ?? []) {
      listener(event as AgentEvent);
    }
    return event;
  }

  async replay(runId: string, afterSequence = 0): Promise<AgentEvent[]> {
    return (this.eventsByRun.get(runId) ?? []).filter(
      (event) => event.sequence > afterSequence,
    );
  }

  subscribe(runId: string, listener: AgentEventListener): () => void {
    const listeners = this.listenersByRun.get(runId) ?? new Set<AgentEventListener>();
    listeners.add(listener);
    this.listenersByRun.set(runId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listenersByRun.delete(runId);
    };
  }
}
