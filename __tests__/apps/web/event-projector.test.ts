import { emptyProjection, projectEvents } from "../../../apps/web/src/lib/event-projector.js";
import type { AgentEvent } from "../../../apps/web/src/types.js";
import { describe, expect, it } from "vitest";

describe("Web Event Projector", () => {
  it("应合并历史回放与实时事件并按sequence去重排序", () => {
    const history = projectEvents(emptyProjection, [event(1, "run.created"), event(2, "node.started", "plan")]);
    const merged = projectEvents(history, [
      event(4, "node.started", "collect"),
      event(2, "node.started", "plan"),
      event(3, "plan.created", "plan"),
    ]);

    expect(merged.events.map((item) => item.sequence)).toEqual([1, 2, 3, 4]);
    expect(merged.lastSequence).toBe(4);
    expect(merged.nodes.plan?.status).toBe("completed");
    expect(merged.nodes.collect?.status).toBe("running");
  });

  it("迟到的旧事件不得让已完成投影回退", () => {
    const completed = projectEvents(emptyProjection, [
      event(8, "node.started", "write_back"),
      event(10, "run.completed", "write_back"),
    ]);
    const withLateEvent = projectEvents(completed, [event(6, "node.started", "verify")]);

    expect(withLateEvent.terminalStatus).toBe("completed");
    expect(withLateEvent.lastSequence).toBe(10);
    expect(withLateEvent.nodes.write_back?.status).toBe("completed");
  });
});

function event(sequence: number, type: string, nodeId?: string): AgentEvent {
  return {
    runId: "run-a",
    sequence,
    type,
    ...(nodeId ? { nodeId } : {}),
    timestamp: new Date(sequence * 1_000).toISOString(),
    payload: {},
  };
}
