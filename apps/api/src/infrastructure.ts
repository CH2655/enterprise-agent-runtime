import {
  InMemoryAgentEventStore,
  type AgentEventStore,
} from "@ear/agent-protocol";
import {
  InMemoryAgentRunStore,
  type AgentRunStore,
} from "@ear/agent-runtime";
import {
  createDatabaseConnection,
  createPostgresToolAuditSink,
  PostgresAgentEventStore,
  PostgresAgentRunStore,
  PostgresKnowledgeRepository,
  PostgresToolIdempotencyStore,
} from "@ear/persistence";
import {
  InMemoryKnowledgeRepository,
  type KnowledgeRepository,
} from "@ear/retrieval";
import {
  InMemoryToolIdempotencyStore,
  type ObjectPermissionPolicy,
  RuleBasedObjectPermissionPolicy,
  type ToolAuditSink,
  type ToolIdempotencyStore,
} from "@ear/tool-registry";
import { type BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export interface RuntimeInfrastructure {
  events: AgentEventStore;
  runs: AgentRunStore;
  idempotency: ToolIdempotencyStore;
  checkpointer: BaseCheckpointSaver;
  toolAudit?: ToolAuditSink;
  objectPermissions: ObjectPermissionPolicy;
  knowledge: KnowledgeRepository;
  close(): Promise<void>;
}

export function createInMemoryInfrastructure(): RuntimeInfrastructure {
  return {
    events: new InMemoryAgentEventStore(),
    runs: new InMemoryAgentRunStore(),
    idempotency: new InMemoryToolIdempotencyStore(),
    checkpointer: new MemorySaver(),
    objectPermissions: createDevelopmentObjectPermissionPolicy(),
    knowledge: new InMemoryKnowledgeRepository(),
    close: async () => undefined,
  };
}

export async function createPostgresInfrastructure(
  connectionString: string,
): Promise<RuntimeInfrastructure> {
  const connection = createDatabaseConnection(connectionString);
  const checkpointer = new PostgresSaver(connection.pool);
  await checkpointer.setup();
  return {
    events: new PostgresAgentEventStore(connection.db),
    runs: new PostgresAgentRunStore(connection.db),
    idempotency: new PostgresToolIdempotencyStore(connection.db),
    checkpointer,
    toolAudit: createPostgresToolAuditSink(connection.db),
    objectPermissions: createDevelopmentObjectPermissionPolicy(),
    knowledge: new PostgresKnowledgeRepository(connection.db),
    close: () => connection.close(),
  };
}

function createDevelopmentObjectPermissionPolicy(): ObjectPermissionPolicy {
  return new RuleBasedObjectPermissionPolicy([
    { appName: "std", metaName: "project", action: "view" },
    { appName: "std", metaName: "supplier", action: "view" },
    { appName: "std", metaName: "supplier", action: "view_finance_summary" },
    { appName: "knowledge", metaName: "supplier_policy", action: "view" },
    { appName: "std", metaName: "rectification_task", action: "create" },
  ]);
}
