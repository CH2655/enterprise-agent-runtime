import type { AgentIdentity } from "@ear/domain";
import type { ToolContext, ToolDefinition, ToolRegistry } from "@ear/tool-registry";
import { z } from "zod";

export const PAAS_FIELD_TYPES = [
  "Text",
  "AutoCode",
  "BizType",
  "Select",
  "MultiSelect",
  "Date",
  "Time",
  "Lookup",
  "MultiLookup",
  "MainDetail",
  "Boolean",
  "District",
  "Location",
  "Integer",
  "Real",
  "Currency",
  "Percent",
  "Image",
  "File",
  "Expression",
  "Aggregation",
  "DynamicLookup",
  "TopAggregation",
] as const;

export type PaasFieldType = (typeof PAAS_FIELD_TYPES)[number];
export type PaasOperation = "get" | "create" | "update";

const BooleanFlagSchema = z.union([z.boolean(), z.literal(0), z.literal(1)]);
export const PaasFieldMetadataSchema = z
  .object({
    name: z.string().min(1),
    label: z.string().min(1),
    type: z.enum(PAAS_FIELD_TYPES),
    subType: z.string().min(1).optional(),
    required: BooleanFlagSchema.optional(),
    readOnly: BooleanFlagSchema.optional(),
    hidden: BooleanFlagSchema.optional(),
    maxLength: z.number().int().positive().optional(),
    decimal: z.number().int().min(0).max(12).optional(),
    permissions: z
      .object({ read: z.boolean(), create: z.boolean(), update: z.boolean() })
      .strict(),
    policy: z
      .object({
        read: z.enum(["plain", "masked", "deny"]),
        write: z.enum(["allow", "deny"]),
      })
      .strict(),
  })
  .strict();

export const PaasObjectActionSchema = z
  .object({
    permissionAction: z.string().min(1),
    requiredScopes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const PaasObjectMetadataSchema = z
  .object({
    source: z.literal("rn-paas-snapshot"),
    version: z.string().min(1),
    appName: z.string().min(1),
    metaName: z.string().min(1),
    label: z.string().min(1),
    fields: z.array(PaasFieldMetadataSchema).min(1),
    actions: z
      .object({
        get: PaasObjectActionSchema.optional(),
        create: PaasObjectActionSchema.optional(),
        update: PaasObjectActionSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type PaasFieldPermissions = z.infer<typeof PaasFieldMetadataSchema>["permissions"];
export type PaasFieldPolicy = z.infer<typeof PaasFieldMetadataSchema>["policy"];
export type PaasFieldMetadata = z.infer<typeof PaasFieldMetadataSchema>;
export type PaasObjectAction = z.infer<typeof PaasObjectActionSchema>;
export type PaasObjectMetadata = z.infer<typeof PaasObjectMetadataSchema>;

export interface PaasGatewayContext {
  identity: AgentIdentity;
  runId: string;
  metadata: PaasObjectMetadata;
}

export interface PaasObjectGateway {
  get(input: {
    objectId: string;
    select: string[];
    context: PaasGatewayContext;
  }): Promise<Record<string, unknown>>;
  create(input: {
    values: Record<string, unknown>;
    context: PaasGatewayContext;
  }): Promise<Record<string, unknown>>;
  update(input: {
    objectId: string;
    patch: Record<string, unknown>;
    context: PaasGatewayContext;
  }): Promise<Record<string, unknown>>;
}

export class PaasMetadataCompilationError extends Error {}

export interface CompilePaasObjectToolsOptions {
  operations?: PaasOperation[];
  exposeToMcp?: boolean;
}

export function registerPaasObjectTools(
  registry: ToolRegistry,
  metadata: PaasObjectMetadata,
  gateway: PaasObjectGateway,
  options: CompilePaasObjectToolsOptions = {},
): void {
  for (const tool of compilePaasObjectTools(metadata, gateway, options)) {
    registry.register(tool);
  }
}

export function compilePaasObjectTools(
  metadataInput: PaasObjectMetadata,
  gateway: PaasObjectGateway,
  options: CompilePaasObjectToolsOptions = {},
): ToolDefinition<any, any>[] {
  const metadata = validateMetadata(metadataInput);
  const operations = options.operations ?? ["get", "create", "update"];
  const exposure = options.exposeToMcp === false ? undefined : (["mcp"] as const);
  const tools: ToolDefinition<any, any>[] = [];

  for (const operation of operations) {
    const action = metadata.actions[operation];
    if (!action) continue;
    const common = {
      name: toolName(metadata.metaName, operation),
      description: toolDescription(metadata.label, operation),
      access: operation === "get" ? ("read" as const) : ("write" as const),
      ...(exposure ? { exposure: [...exposure] } : {}),
      requiredScopes: action.requiredScopes,
    };

    if (operation === "get") {
      const outputFields = readableFields(metadata.fields);
      const outputSchema = recordOutputSchema(outputFields);
      tools.push({
        ...common,
        inputSchema: z.object({ objectId: z.string().min(1) }).strict(),
        outputSchema,
        permission: ({ objectId }) => permissionRequest(metadata, action, objectId),
        async execute({ objectId }, context) {
          const record = await gateway.get({
            objectId,
            select: outputFields.map((field) => field.name),
            context: gatewayContext(metadata, context),
          });
          return sanitizeRecord(record, outputFields, metadata.version);
        },
      });
      continue;
    }

    const writable = writableFields(metadata.fields, operation);
    const valueSchema = recordInputSchema(writable, operation === "create");
    const outputFields = readableFields(metadata.fields);
    const outputSchema = recordOutputSchema(outputFields);
    if (operation === "create") {
      tools.push({
        ...common,
        inputSchema: z.object({ values: valueSchema }).strict(),
        outputSchema,
        permission: () => permissionRequest(metadata, action),
        async execute({ values }, context) {
          const record = await gateway.create({
            values,
            context: gatewayContext(metadata, context),
          });
          return sanitizeRecord(record, outputFields, metadata.version);
        },
      });
    } else {
      tools.push({
        ...common,
        inputSchema: z.object({ objectId: z.string().min(1), patch: valueSchema }).strict(),
        outputSchema,
        permission: ({ objectId }) => permissionRequest(metadata, action, objectId),
        async execute({ objectId, patch }, context) {
          const record = await gateway.update({
            objectId,
            patch,
            context: gatewayContext(metadata, context),
          });
          return sanitizeRecord(record, outputFields, metadata.version);
        },
      });
    }
  }

  return tools;
}

export function paasToolName(metaName: string, operation: PaasOperation): string {
  return toolName(metaName, operation);
}

function validateMetadata(metadata: PaasObjectMetadata): PaasObjectMetadata {
  const parsed = PaasObjectMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    throw new PaasMetadataCompilationError(
      `Invalid PaaS object metadata: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const names = new Set<string>();
  for (const field of parsed.data.fields) {
    if (names.has(field.name)) {
      throw new PaasMetadataCompilationError(`Duplicate PaaS field: ${field.name}`);
    }
    names.add(field.name);
  }
  return parsed.data;
}

function readableFields(fields: PaasFieldMetadata[]): PaasFieldMetadata[] {
  return fields.filter(
    (field) =>
      field.permissions.read &&
      !asBoolean(field.hidden) &&
      field.policy.read !== "deny",
  );
}

function writableFields(
  fields: PaasFieldMetadata[],
  operation: "create" | "update",
): PaasFieldMetadata[] {
  return fields.filter(
    (field) =>
      field.permissions[operation] &&
      field.policy.write === "allow" &&
      !asBoolean(field.hidden) &&
      !asBoolean(field.readOnly) &&
      !isComputedType(field.type),
  );
}

function recordInputSchema(fields: PaasFieldMetadata[], required: boolean): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const schema = fieldValueSchema(field);
    shape[field.name] = required && asBoolean(field.required) ? schema : schema.optional();
  }
  return z
    .object(shape)
    .strict()
    .refine((value) => Object.keys(value).length > 0, "At least one writable field is required");
}

function recordOutputSchema(fields: PaasFieldMetadata[]): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const schema = field.policy.read === "masked" ? z.string() : fieldValueSchema(field);
    shape[field.name] = schema.nullable().optional();
  }
  return z
    .object({
      metadataVersion: z.string().min(1),
      record: z.object(shape).strict(),
    })
    .strict();
}

function fieldValueSchema(field: PaasFieldMetadata): z.ZodType {
  const text = () => {
    let schema = z.string();
    if (field.maxLength) schema = schema.max(field.maxLength);
    return schema;
  };
  switch (field.type) {
    case "Text":
    case "AutoCode":
    case "BizType":
    case "Select":
    case "Time":
      return text();
    case "Date":
      return z.iso.date();
    case "MultiSelect":
      return z.array(z.string());
    case "Integer":
      return z.number().int();
    case "Real":
    case "Currency":
    case "Percent":
    case "Aggregation":
      return z.number();
    case "Expression":
    case "TopAggregation":
      return computedValueSchema(field.subType);
    case "Boolean":
      return z.boolean();
    case "Lookup":
      return referenceSchema();
    case "MultiLookup":
      return z.array(referenceSchema());
    case "DynamicLookup":
      return referenceSchema().extend({ metaName: z.string().min(1) });
    case "MainDetail":
      return z.array(z.record(z.string(), z.unknown()));
    case "District":
      return z.object({ codes: z.array(z.string()), labels: z.array(z.string()) }).strict();
    case "Location":
      return z
        .object({ latitude: z.number(), longitude: z.number(), address: z.string().optional() })
        .strict();
    case "Image":
    case "File":
      return z.array(
        z.object({ id: z.string().min(1), name: z.string().min(1), url: z.string().optional() }).strict(),
      );
  }
}

function computedValueSchema(subType: string | undefined): z.ZodType {
  if (subType === "Text" || subType === "Time") return z.string();
  if (subType === "Date") return z.iso.date();
  return z.number();
}

function referenceSchema() {
  return z.object({ code: z.string().min(1), name: z.string().optional() }).strict();
}

function sanitizeRecord(
  raw: Record<string, unknown>,
  fields: PaasFieldMetadata[],
  metadataVersion: string,
): { metadataVersion: string; record: Record<string, unknown> } {
  const record: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field.name];
    if (value === undefined) continue;
    record[field.name] =
      value === null || field.policy.read !== "masked" ? value : maskValue(value);
  }
  return { metadataVersion, record };
}

function maskValue(value: unknown): string {
  const text = String(value);
  return text.length <= 4 ? "****" : `****${text.slice(-4)}`;
}

function isComputedType(type: PaasFieldType): boolean {
  return type === "Expression" || type === "Aggregation" || type === "TopAggregation";
}

function asBoolean(value: boolean | 0 | 1 | undefined): boolean {
  return value === true || value === 1;
}

function gatewayContext(metadata: PaasObjectMetadata, context: ToolContext): PaasGatewayContext {
  return { identity: context.identity, runId: context.runId, metadata };
}

function permissionRequest(
  metadata: PaasObjectMetadata,
  action: PaasObjectAction,
  objectId?: string,
) {
  return {
    appName: metadata.appName,
    metaName: metadata.metaName,
    action: action.permissionAction,
    ...(objectId ? { objectId } : {}),
  };
}

function toolName(metaName: string, operation: PaasOperation): string {
  const normalized = metaName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .toLowerCase();
  return `paas_${normalized}_${operation}`;
}

function toolDescription(label: string, operation: PaasOperation): string {
  const verbs = { get: "读取", create: "创建", update: "更新" } as const;
  return `${verbs[operation]}当前租户有权访问的${label}`;
}
