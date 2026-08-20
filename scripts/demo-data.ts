export interface DemoSeedSummary {
  created: string[];
  skipped: string[];
  approved: string[];
}

interface DemoRun {
  id: string;
  agentId: string;
  status: string;
  input: Record<string, unknown>;
}

interface DemoScenario {
  key: string;
  tenantId: string;
  userId: string;
  agentId: "risk-agent" | "contract-agent";
  input: Record<string, unknown>;
  complete: boolean;
}

const scenarios: DemoScenario[] = [
  {
    key: "tenant-a-risk-review",
    tenantId: "tenant-a",
    userId: "reviewer-a",
    agentId: "risk-agent",
    input: {
      caseId: "DEMO-RISK-001",
      projectCode: "P-DEMO-2026",
      supplierCode: "SUP-HIGH-RISK",
    },
    complete: false,
  },
  {
    key: "tenant-a-contract-completed",
    tenantId: "tenant-a",
    userId: "reviewer-a",
    agentId: "contract-agent",
    input: {
      contractId: "DEMO-CONTRACT-001",
      supplierCode: "SUP-CONTRACT",
    },
    complete: true,
  },
  {
    key: "tenant-b-isolation",
    tenantId: "tenant-b",
    userId: "reviewer-b",
    agentId: "risk-agent",
    input: {
      caseId: "DEMO-RISK-B-001",
      projectCode: "P-NORTH-2026",
      supplierCode: "SUP-TENANT-B",
    },
    complete: false,
  },
];

export async function seedDemoData(
  apiBaseUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<DemoSeedSummary> {
  const summary: DemoSeedSummary = { created: [], skipped: [], approved: [] };
  for (const scenario of scenarios) {
    const headers = identityHeaders(scenario);
    const runs = await request<DemoRun[]>(fetchImpl, apiBaseUrl, "/runs?limit=100", headers);
    let run = runs.find((candidate) => matchesScenario(candidate, scenario));
    if (!run) {
      run = await request<DemoRun>(fetchImpl, apiBaseUrl, "/runs?mode=sync", headers, {
        method: "POST",
        body: JSON.stringify({ agentId: scenario.agentId, input: scenario.input }),
      });
      summary.created.push(scenario.key);
    } else {
      summary.skipped.push(scenario.key);
    }
    if (scenario.complete && run.status === "waiting_approval") {
      await request<DemoRun>(fetchImpl, apiBaseUrl, `/runs/${run.id}/approve`, headers, {
        method: "POST",
      });
      summary.approved.push(scenario.key);
    }
  }
  return summary;
}

function identityHeaders(scenario: DemoScenario): Record<string, string> {
  return {
    "x-demo-tenant": scenario.tenantId,
    "x-demo-user": scenario.userId,
  };
}

function matchesScenario(run: DemoRun, scenario: DemoScenario): boolean {
  if (run.agentId !== scenario.agentId) return false;
  const businessId = scenario.agentId === "risk-agent" ? "caseId" : "contractId";
  return run.input[businessId] === scenario.input[businessId];
}

async function request<T>(
  fetchImpl: typeof fetch,
  apiBaseUrl: string,
  path: string,
  identity: Record<string, string>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchImpl(`${apiBaseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      ...identity,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Demo seed request failed (${response.status}): ${body}`);
  }
  return response.json() as Promise<T>;
}
