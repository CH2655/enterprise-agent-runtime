import { randomUUID } from "node:crypto";
import type { AgentIdentity } from "@ear/domain";
import type { z } from "zod";

export interface ToolContext {
  identity: AgentIdentity;
  runId: string;
  idempotencyKey?: string;
}

export interface ToolApproval {
  approved: true;
  approvedBy: string;
}

export interface ToolExecutionOptions {
  approval?: ToolApproval;
  idempotencyKey?: string;
}

export interface ObjectPermissionRequest {
  appName: string;
  metaName: string;
  action: string;
  objectId?: string;
}

export interface ObjectPermissionContext {
  identity: AgentIdentity;
  runId: string;
  request: ObjectPermissionRequest;
}

export interface ObjectPermissionPolicy {
  authorize(context: ObjectPermissionContext): Promise<boolean>;
}

export interface ObjectPermissionRule extends ObjectPermissionRequest {
  tenantId?: string;
  userId?: string;
}

export class DenyObjectPermissionPolicy implements ObjectPermissionPolicy {
  async authorize(): Promise<boolean> {
    return false;
  }
}

export class RuleBasedObjectPermissionPolicy implements ObjectPermissionPolicy {
  constructor(private readonly rules: ObjectPermissionRule[]) {}

  async authorize(context: ObjectPermissionContext): Promise<boolean> {
    return this.rules.some((rule) => matchesPermissionRule(rule, context));
  }
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  access: "read" | "write";
  requiredScopes?: string[];
  permission?: (input: TInput) => ObjectPermissionRequest;
  inputSchema: z.ZodType<TInput>;
  outputSchema: z.ZodType<TOutput>;
  timeoutMs?: number;
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

export interface ToolAuditRecord {
  invocationId: string;
  runId: string;
  tenantId: string;
  userId: string;
  toolName: string;
  access: "read" | "write";
  status: "started" | "completed" | "failed";
  durationMs?: number;
  error?: string;
}

export type ToolAuditSink = (record: ToolAuditRecord) => void | Promise<void>;

export type IdempotencyBeginResult =
  | { status: "execute" }
  | { status: "completed"; result: unknown }
  | { status: "in_progress" };

export interface ToolIdempotencyStore {
  begin(input: {
    tenantId: string;
    toolName: string;
    key: string;
    runId: string;
  }): Promise<IdempotencyBeginResult>;
  complete(input: {
    tenantId: string;
    toolName: string;
    key: string;
    result: unknown;
  }): Promise<void>;
  fail(input: {
    tenantId: string;
    toolName: string;
    key: string;
    error: string;
  }): Promise<void>;
}

interface InMemoryIdempotencyRecord {
  status: "started" | "completed" | "failed";
  result?: unknown;
}

export class InMemoryToolIdempotencyStore implements ToolIdempotencyStore {
  private readonly records = new Map<string, InMemoryIdempotencyRecord>();

  async begin(input: {
    tenantId: string;
    toolName: string;
    key: string;
    runId: string;
  }): Promise<IdempotencyBeginResult> {
    const id = idempotencyRecordId(input);
    const current = this.records.get(id);
    if (current?.status === "completed") {
      return { status: "completed", result: current.result };
    }
    if (current?.status === "started") return { status: "in_progress" };
    this.records.set(id, { status: "started" });
    return { status: "execute" };
  }

  async complete(input: {
    tenantId: string;
    toolName: string;
    key: string;
    result: unknown;
  }): Promise<void> {
    this.records.set(idempotencyRecordId(input), { status: "completed", result: input.result });
  }

  async fail(input: {
    tenantId: string;
    toolName: string;
    key: string;
    error: string;
  }): Promise<void> {
    this.records.set(idempotencyRecordId(input), { status: "failed" });
  }
}

export class ToolNotFoundError extends Error {}
export class ToolValidationError extends Error {}
export class ToolAuthorizationError extends Error {}
export class ToolApprovalRequiredError extends Error {}
export class ToolIdempotencyKeyRequiredError extends Error {}
export class ToolExecutionInProgressError extends Error {}
export class ToolTimeoutError extends Error {}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    private readonly auditSink?: ToolAuditSink,
    private readonly idempotencyStore: ToolIdempotencyStore = new InMemoryToolIdempotencyStore(),
    private readonly objectPermissions: ObjectPermissionPolicy = new DenyObjectPermissionPolicy(),
  ) {}

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, definition as ToolDefinition);
  }

  list(): Array<Pick<ToolDefinition, "name" | "description" | "access">> {
    return [...this.tools.values()].map(({ name, description, access }) => ({
      name,
      description,
      access,
    }));
  }

  async execute<TOutput>(
    name: string,
    rawInput: unknown,
    context: ToolContext,
    options: ToolExecutionOptions = {},
  ): Promise<TOutput> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(`Unknown tool: ${name}`);

    const input = tool.inputSchema.safeParse(rawInput);
    if (!input.success) {
      throw new ToolValidationError(
        `Invalid input for ${name}: ${input.error.issues.map((issue) => issue.message).join("; ")}`,
      );
    }

    const missingScopes = (tool.requiredScopes ?? []).filter(
      (scope) => !context.identity.scopes?.includes(scope),
    );
    if (missingScopes.length > 0) {
      throw new ToolAuthorizationError(
        `Missing scopes for ${name}: ${missingScopes.join(", ")}`,
      );
    }

    if (tool.permission) {
      const request = tool.permission(input.data);
      const authorized = await this.objectPermissions.authorize({
        identity: context.identity,
        runId: context.runId,
        request,
      });
      if (!authorized) {
        throw new ToolAuthorizationError(
          `Object permission denied for ${name}: ${request.appName}/${request.metaName}/${request.action}`,
        );
      }
    }

    if (tool.access === "write" && !options.approval?.approved) {
      throw new ToolApprovalRequiredError(`Write tool requires approval: ${name}`);
    }
    if (tool.access === "write" && !options.idempotencyKey) {
      throw new ToolIdempotencyKeyRequiredError(
        `Write tool requires an idempotency key: ${name}`,
      );
    }

    const idempotencyInput = options.idempotencyKey
      ? {
          tenantId: context.identity.tenantId,
          toolName: name,
          key: options.idempotencyKey,
          runId: context.runId,
        }
      : undefined;
    if (idempotencyInput) {
      const begin = await this.idempotencyStore.begin(idempotencyInput);
      if (begin.status === "in_progress") {
        throw new ToolExecutionInProgressError(`Write tool is already executing: ${name}`);
      }
      if (begin.status === "completed") {
        const cached = tool.outputSchema.parse(begin.result);
        return cached as TOutput;
      }
    }

    const startedAt = Date.now();
    const invocationId = randomUUID();
    await this.auditSink?.({
      invocationId,
      runId: context.runId,
      tenantId: context.identity.tenantId,
      userId: context.identity.userId,
      toolName: name,
      access: tool.access,
      status: "started",
    });

    try {
      const output = await withTimeout(
        tool.execute(input.data, {
          ...context,
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        }),
        tool.timeoutMs ?? 10_000,
        name,
      );
      const validatedOutput = tool.outputSchema.safeParse(output);
      if (!validatedOutput.success) {
        throw new ToolValidationError(
          `Invalid output for ${name}: ${validatedOutput.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      if (idempotencyInput) {
        await this.idempotencyStore.complete({
          ...idempotencyInput,
          result: validatedOutput.data,
        });
      }
      await this.auditSink?.({
        invocationId,
        runId: context.runId,
        tenantId: context.identity.tenantId,
        userId: context.identity.userId,
        toolName: name,
        access: tool.access,
        status: "completed",
        durationMs: Date.now() - startedAt,
      });
      return validatedOutput.data as TOutput;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (idempotencyInput) {
        await this.idempotencyStore.fail({ ...idempotencyInput, error: message });
      }
      await this.auditSink?.({
        invocationId,
        runId: context.runId,
        tenantId: context.identity.tenantId,
        userId: context.identity.userId,
        toolName: name,
        access: tool.access,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: message,
      });
      throw error;
    }
  }
}

function matchesPermissionRule(
  rule: ObjectPermissionRule,
  context: ObjectPermissionContext,
): boolean {
  const matches = (expected: string | undefined, actual: string | undefined) =>
    expected === undefined || expected === "*" || expected === actual;
  return (
    matches(rule.tenantId, context.identity.tenantId) &&
    matches(rule.userId, context.identity.userId) &&
    matches(rule.appName, context.request.appName) &&
    matches(rule.metaName, context.request.metaName) &&
    matches(rule.action, context.request.action) &&
    matches(rule.objectId, context.request.objectId)
  );
}

function idempotencyRecordId(input: {
  tenantId: string;
  toolName: string;
  key: string;
}): string {
  return `${input.tenantId}:${input.toolName}:${input.key}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ToolTimeoutError(`Tool timed out after ${timeoutMs}ms: ${toolName}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
