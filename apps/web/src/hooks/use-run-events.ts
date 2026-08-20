import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { getRunEvents, streamRunEvents } from "../api";
import { useEventStore } from "../stores/event-store";
import type { DemoIdentity } from "../types";

export function useRunEvents(runId: string | undefined, identity: DemoIdentity): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    const store = useEventStore.getState();
    store.clearRun(runId);

    const connect = async () => {
      let delay = 500;
      store.setConnection(runId, "connecting");
      try {
        const history = await getRunEvents(runId, 0, identity);
        useEventStore.getState().ingest(runId, history);
      } catch {
        useEventStore.getState().setConnection(runId, "reconnecting");
      }
      while (!controller.signal.aborted) {
        try {
          const after = useEventStore.getState().runs[runId]?.lastSequence ?? 0;
          useEventStore.getState().setConnection(runId, "live");
          await streamRunEvents({
            runId,
            after,
            identity,
            signal: controller.signal,
            onEvent: (event) => {
              useEventStore.getState().ingest(runId, [event]);
              if (["approval.required", "approval.completed", "run.completed", "run.failed"]
                .includes(event.type)) {
                void queryClient.invalidateQueries({ queryKey: ["run", identity.tenantId, runId] });
                void queryClient.invalidateQueries({ queryKey: ["runs", identity.tenantId] });
              }
            },
          });
          delay = 500;
        } catch {
          if (controller.signal.aborted) break;
          useEventStore.getState().setConnection(runId, "reconnecting");
          await sleep(delay, controller.signal);
          delay = Math.min(delay * 2, 5_000);
        }
      }
    };
    void connect();
    return () => controller.abort();
  }, [identity.tenantId, identity.userId, identity.token, queryClient, runId]);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
