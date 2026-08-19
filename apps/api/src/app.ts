import {
  AgentRegistry,
  AgentRuntime,
  InvalidRunStateError,
  RunAccessDeniedError,
} from "@ear/agent-runtime";
import { InMemoryAgentEventStore } from "@ear/agent-protocol";
import { identityFromJwtClaims } from "@ear/auth";
import { AgentIdentitySchema } from "@ear/domain";
import { createRiskAgentDefinition, registerMockPaasTools } from "@ear/risk-agent";
import { ToolAuthorizationError, ToolRegistry } from "@ear/tool-registry";
import fastifyJwt from "@fastify/jwt";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createInMemoryInfrastructure,
  type RuntimeInfrastructure,
} from "./infrastructure.js";

const startRunBody = z.object({
  agentId: z.string().min(1),
  input: z.unknown(),
});

const runParams = z.object({ runId: z.string().uuid() });

export type AppAuthOptions =
  | { mode: "demo" }
  | {
      mode: "jwt";
      secret: string;
      issuer: string;
      audience: string;
    };

export interface CreateAppOptions {
  auth?: AppAuthOptions;
  infrastructure?: RuntimeInfrastructure;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = Fastify({ logger: false });
  const auth = options.auth ?? { mode: "demo" as const };
  if (auth.mode === "jwt") {
    app.register(fastifyJwt, {
      secret: auth.secret,
      verify: {
        allowedIss: auth.issuer,
        allowedAud: auth.audience,
      },
    });
  }
  const infrastructure = options.infrastructure ?? createInMemoryInfrastructure();
  const events = infrastructure.events;
  const tools = new ToolRegistry(async (audit) => {
    await infrastructure.toolAudit?.(audit);
    await events.append(audit.runId, {
      type:
        audit.status === "started"
          ? "tool.started"
          : audit.status === "completed"
            ? "tool.completed"
            : "tool.failed",
      payload: audit,
    });
  }, infrastructure.idempotency, infrastructure.objectPermissions);
  registerMockPaasTools(tools);
  const agents = new AgentRegistry();
  agents.register(createRiskAgentDefinition(infrastructure.checkpointer));
  const runtime = new AgentRuntime(agents, tools, events, infrastructure.runs);

  app.addHook("onReady", async () => {
    await runtime.recoverApprovedRuns();
  });

  app.addHook("onClose", async () => {
    await infrastructure.close();
  });

  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/agents", async () => runtime.listAgents());

  app.post("/api/runs", async (request, reply) => {
    const body = startRunBody.parse(request.body);
    const run = await runtime.start(body.agentId, body.input, await identityFrom(request, auth));
    return reply.code(201).send(run);
  });

  app.get("/api/runs/:runId", async (request) => {
    const { runId } = runParams.parse(request.params);
    return await runtime.getRun(runId, await identityFrom(request, auth));
  });

  app.get("/api/runs/:runId/transitions", async (request) => {
    const { runId } = runParams.parse(request.params);
    return runtime.getRunTransitions(runId, await identityFrom(request, auth));
  });

  app.post("/api/runs/:runId/approve", async (request) => {
    const { runId } = runParams.parse(request.params);
    return runtime.approve(runId, await identityFrom(request, auth));
  });

  app.get("/api/runs/:runId/events", async (request) => {
    const { runId } = runParams.parse(request.params);
    await runtime.getRun(runId, await identityFrom(request, auth));
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return await events.replay(runId, query.after);
  });

  app.get("/api/runs/:runId/events/stream", async (request, reply) => {
    const { runId } = runParams.parse(request.params);
    await runtime.getRun(runId, await identityFrom(request, auth));
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const event of await events.replay(runId, query.after)) {
      reply.raw.write(toSse(event));
    }
    const unsubscribe = events.subscribe(runId, (event) => reply.raw.write(toSse(event)));
    request.raw.on("close", unsubscribe);
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    const providedStatus = "statusCode" in normalized ? Number(normalized.statusCode) : undefined;
    const statusCode = normalized.name === "ZodError"
      ? 400
      : normalized instanceof RunAccessDeniedError || normalized instanceof ToolAuthorizationError
        ? 403
        : normalized instanceof InvalidRunStateError
          ? 409
          : providedStatus && providedStatus >= 400 && providedStatus < 600
            ? providedStatus
            : 500;
    reply.code(statusCode).send({ error: normalized.name, message: normalized.message });
  });

  return { app, runtime, events, tools, infrastructure };
}

async function identityFrom(request: FastifyRequest, auth: AppAuthOptions) {
  if (auth.mode === "jwt") {
    await request.jwtVerify();
    return identityFromJwtClaims(request.user, request.id);
  }
  return AgentIdentitySchema.parse({
    tenantId: request.headers["x-demo-tenant"],
    userId: request.headers["x-demo-user"],
    roles: ["risk_reviewer"],
    scopes: ["risk:read", "risk:approve", "risk:write"],
  });
}

function toSse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}
