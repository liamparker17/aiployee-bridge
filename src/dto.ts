import { z } from "zod";
import { NodeType } from "./schema/node.js";

// Bridge-facing DTOs. These are what the MCP tool surface accepts and
// returns. camelCase, edges keyed by uuid + branch label, no rete
// `number` exposed. Convert to/from wire shape in `normalize.ts`.

export const Position = z.object({ x: z.number(), y: z.number() });
export type Position = z.infer<typeof Position>;

// --- Per-type config (DTO side) ---
// Discriminated by `kind`. Matches NodeType on the wire 1:1 — keeping the
// same string saves a translation table at the boundary. Only the three
// observed types are pinned; the rest accept arbitrary `raw` until each
// is recon'd.

const PhoneNumberList = z.array(z.string()).default([]);

export const InboundCallConfig = z.object({
  kind: z.literal("inbound_call"),
  phoneNumbers: PhoneNumberList,
  cancelPrevExecuting: z.boolean().default(false),
  googleSheetsSync: z
    .object({
      enabled: z.boolean(),
      sheetId: z.string().nullable(),
      sheetName: z.string().nullable(),
    })
    .optional(),
});

export const ConnectCallAgentConfig = z.object({
  kind: z.literal("connect_call_agent"),
  agentUuid: z.string().uuid(),
  agentType: z.enum(["ai", "real"]).default("ai"),
  copyAgent: z.boolean().default(false),
  prompt: z.string().nullable().default(null),
  phoneNumbers: PhoneNumberList,
  actions: z.array(z.unknown()).default([]),
});

export const CallConfig = z.object({
  kind: z.literal("call"),
  agentUuid: z.string().uuid(),
  copyAgent: z.boolean().default(false),
  prompt: z.string().nullable().default(null),
  phoneNumbers: PhoneNumberList,
  actions: z.array(z.unknown()).default([]),
  maxConcurrentExecuting: z.number().int().nullable().default(null),
  retryPolicy: z
    .object({
      isActive: z.boolean(),
      rules: z.array(z.unknown()),
    })
    .default({ isActive: false, rules: [] }),
});

// Fallback for the 11 types that haven't had their data block decoded
// yet. The wire data block passes through opaquely.
export const RawConfig = z.object({
  kind: z.enum([
    "internet_call",
    "event",
    "now",
    "split",
    "delay",
    "filter",
    "update_data",
    "ai_data_generation",
    "sms",
    "email",
    "api_request",
  ]),
  raw: z.record(z.string(), z.unknown()).default({}),
});

export const NodeConfig = z.discriminatedUnion("kind", [
  InboundCallConfig,
  ConnectCallAgentConfig,
  CallConfig,
  RawConfig,
]);
export type NodeConfig = z.infer<typeof NodeConfig>;

// --- Node + Connection (DTO side) ---

export const NodeDTO = z.object({
  /** Stable across saves. New nodes pass `null` — the server assigns. */
  uuid: z.string().uuid().nullable(),
  name: z.string(),
  position: Position,
  config: NodeConfig,
  /** Defaults to 1 (enabled). */
  status: z.number().int().default(1),
});
export type NodeDTO = z.infer<typeof NodeDTO>;

/**
 * An edge between two nodes. Source side accepts either a numeric index
 * or a branch label (case-insensitive, both "Transferred" and the
 * platform's "Transfered" spelling are accepted).
 */
export const ConnectionDTO = z.object({
  fromNode: z.string().uuid(),
  /** "Completed" | "Transferred" | "Transfered" | number index */
  fromOutput: z.union([z.number().int().nonnegative(), z.string()]),
  toNode: z.string().uuid(),
  toInput: z.number().int().nonnegative().default(0),
});
export type ConnectionDTO = z.infer<typeof ConnectionDTO>;

export const FlowDTO = z.object({
  uuid: z.string().uuid(),
  name: z.string(),
  description: z.string().default(""),
  nodes: z.array(NodeDTO),
  connections: z.array(ConnectionDTO),
});
export type FlowDTO = z.infer<typeof FlowDTO>;

// --- Helpers ---

/**
 * Wire-type whitelist for nodes that originate a flow (no input edges).
 * Used by validators and the trigger-uniqueness rule.
 */
export const TRIGGER_TYPES: ReadonlySet<NodeType> = new Set([
  "inbound_call",
  "internet_call",
  "event",
  "now",
] as const);

/** Convert a DTO config's `kind` to the wire `type`. They match 1:1. */
export function configKindToWireType(kind: NodeConfig["kind"]): NodeType {
  return kind;
}
