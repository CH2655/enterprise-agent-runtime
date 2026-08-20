import type {
  AgentEvent,
  AgentRun,
  AgentRunSummary,
  DemoIdentity,
  RiskCaseInput,
  RunStatus,
} from "./types";

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

export async function listRuns(
  identity: DemoIdentity,
  status?: RunStatus,
): Promise<AgentRunSummary[]> {
  const query = new URLSearchParams({ limit: "50" });
  if (status) query.set("status", status);
  return request(`/runs?${query}`, identity);
}

export function getRun(runId: string, identity: DemoIdentity): Promise<AgentRun> {
  return request(`/runs/${runId}`, identity);
}

export function createRun(input: RiskCaseInput, identity: DemoIdentity): Promise<AgentRun> {
  return request("/runs?mode=async", identity, {
    method: "POST",
    body: JSON.stringify({ agentId: "risk-agent", input }),
  });
}

export function approveRun(runId: string, identity: DemoIdentity): Promise<AgentRun> {
  return request(`/runs/${runId}/approve`, identity, { method: "POST" });
}

export function getRunEvents(
  runId: string,
  after: number,
  identity: DemoIdentity,
): Promise<AgentEvent[]> {
  return request(`/runs/${runId}/events?after=${after}`, identity);
}

export async function streamRunEvents(input: {
  runId: string;
  after: number;
  identity: DemoIdentity;
  signal: AbortSignal;
  onEvent(event: AgentEvent): void;
}): Promise<void> {
  const response = await fetch(
    `${API_BASE}/runs/${input.runId}/events/stream?after=${input.after}`,
    {
      headers: { ...identityHeaders(input.identity), accept: "text/event-stream" },
      signal: input.signal,
    },
  );
  if (!response.ok || !response.body) throw await responseError(response);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!input.signal.aborted) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const payload = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (payload) input.onEvent(JSON.parse(payload) as AgentEvent);
    }
  }
}

async function request<T>(
  path: string,
  identity: DemoIdentity,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...identityHeaders(identity),
      ...init.headers,
    },
  });
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

export function identityHeaders(identity: DemoIdentity): Record<string, string> {
  if (identity.token) return { authorization: `Bearer ${identity.token}` };
  return {
    "x-demo-tenant": identity.tenantId,
    "x-demo-user": identity.userId,
  };
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => undefined) as
    | { message?: string; error?: string }
    | undefined;
  return new Error(body?.message ?? body?.error ?? `Request failed (${response.status})`);
}
