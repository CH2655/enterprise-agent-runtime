export type RunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface RiskCaseInput {
  caseId: string;
  projectCode: string;
  supplierCode: string;
}

export interface EvidenceRecord {
  id: string;
  category: string;
  sourceType: "document" | "knowledge" | "business_object" | "tool";
  sourceId: string;
  content: string;
  locator?: string;
  hash?: string;
  collectedAt: string;
}

export interface RiskFinding {
  id: string;
  dimension: string;
  level: "low" | "medium" | "high";
  claim: string;
  evidenceIds: string[];
  confidence: number;
  recommendation: string;
}

export interface RiskAgentState {
  status?: RunStatus;
  iteration?: number;
  coverage?: number;
  missingCategories?: string[];
  evidence?: EvidenceRecord[];
  findings?: RiskFinding[];
  verificationIssues?: string[];
  toolFailures?: Record<string, string>;
  writeBack?: { taskId: string; created: boolean };
}

export interface AgentRun {
  id: string;
  agentId: string;
  agentVersion: string;
  tenantId: string;
  userId: string;
  status: RunStatus;
  input: RiskCaseInput;
  state: RiskAgentState;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRunSummary {
  id: string;
  agentId: string;
  agentVersion: string;
  userId: string;
  status: RunStatus;
  input: RiskCaseInput;
  createdAt: string;
  updatedAt: string;
  summary: {
    coverage: number;
    evidenceCount: number;
    findingCount: number;
  };
}

export interface AgentEvent {
  runId: string;
  sequence: number;
  type: string;
  nodeId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface DemoIdentity {
  tenantId: string;
  userId: string;
  token?: string;
}
