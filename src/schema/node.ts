import { z } from "zod";

// The wire-side node shape. Mirrors what /v1/nodes/save accepts and what
// /v1/flows/{uuid}/nodes returns. Field names match the wire exactly
// (snake_case); normalisation to camelCase happens at the tool-surface
// boundary, not here.

export const Connection = z.object({
  node_number: z.number().int(),
  node_socket: z.string(), // e.g. "ID_21_0" / "OD_18_0"
});
export type Connection = z.infer<typeof Connection>;

export const Socket = z.object({
  id: z.string(), // "ID_<number>_<i>" or "OD_<number>_<i>"
  name: z.string().nullable(),
  connections: z.array(Connection),
});
export type Socket = z.infer<typeof Socket>;

// --- Per-type `data` blocks ---
// Only three shapes are fully observed. The rest fall back to a
// permissive object until first-call discovery pins them down.

export const InboundCallData = z.object({
  data_key: z.string(),
  phone_numbers: z.array(z.string()),
  cancel_prev_executing: z.boolean(),
  google_sheets_sync_data: z.object({
    use_google_sync: z.boolean(),
    google_sheet_id: z.string().nullable(),
    google_sheet_name: z.string().nullable(),
  }),
});

export const ConnectCallAgentData = z.object({
  data_key: z.string(),
  actions: z.array(z.unknown()),
  connect_agent_params: z.object({
    copy: z.boolean(),
    type: z.enum(["ai", "real"]),
    uuid: z.string(),
    prompt: z.string().nullable(),
    phone_numbers: z.array(z.string()),
  }),
});

export const CallData = z.object({
  data_key: z.string(),
  actions: z.array(z.unknown()),
  max_concurrent_executing: z.number().int().nullable(),
  retry_policy: z.object({
    is_active: z.boolean(),
    rules: z.array(z.unknown()),
  }),
  agent_params: z.object({
    copy: z.boolean(),
    uuid: z.string(),
    prompt: z.string().nullable(),
    phone_numbers: z.array(z.string()),
  }),
});

// Wire `type` values. The first three have their `data` block schemas
// above; the rest are accepted with a permissive data block until each
// is observed.
export const NodeType = z.enum([
  "inbound_call",
  "connect_call_agent",
  "call",
  "internet_call",
  "event",
  "now",
  "split",
  "delay",
  "filter", // UI label: "Condition"
  "update_data", // UI label: "Webhook"
  "ai_data_generation", // UI label: "LLM"
  "sms",
  "email",
  "api_request",
]);
export type NodeType = z.infer<typeof NodeType>;

// Internal-name → UI-label mapping. The wire ALWAYS uses the internal
// name; the bridge exposes UI labels in its tool surface for human
// readability and translates here.
export const NODE_TYPE_TO_UI_LABEL: Record<NodeType, string> = {
  inbound_call: "Inbound Call",
  connect_call_agent: "Connect Call Agent",
  call: "Call",
  internet_call: "Internet Call",
  event: "Event",
  now: "Now",
  split: "Split",
  delay: "Delay",
  filter: "Condition",
  update_data: "Webhook",
  ai_data_generation: "LLM",
  sms: "SMS",
  email: "Email",
  api_request: "API Request",
};

export const UI_LABEL_TO_NODE_TYPE: Record<string, NodeType> = Object.fromEntries(
  Object.entries(NODE_TYPE_TO_UI_LABEL).map(([wire, ui]) => [ui, wire as NodeType]),
) as Record<string, NodeType>;

// Lookup by either side. Accepts case-insensitive UI labels and the
// wire name itself. Returns the wire name.
export function resolveNodeType(input: string): NodeType {
  const trimmed = input.trim();
  if ((NodeType.options as readonly string[]).includes(trimmed)) {
    return trimmed as NodeType;
  }
  for (const [ui, wire] of Object.entries(UI_LABEL_TO_NODE_TYPE)) {
    if (ui.toLowerCase() === trimmed.toLowerCase()) return wire;
  }
  throw new Error(`unknown node type: ${input}`);
}

// Permissive data block — used until each type's shape is pinned.
const PermissiveData = z.object({ data_key: z.string() }).passthrough();

// Discriminated union of known + permissive fallback. The bridge
// validates strictly against known types and lets unknowns through as
// `passthrough` so partially-recon'd flows still load.
const NodeDataByType = {
  inbound_call: InboundCallData,
  connect_call_agent: ConnectCallAgentData,
  call: CallData,
} satisfies Partial<Record<NodeType, z.ZodTypeAny>>;

export const FlowNode = z.object({
  uuid: z.string().uuid(),
  name: z.string(),
  type: NodeType,
  status: z.number().int(), // 1 = enabled
  number: z.number().int(),
  position: z.tuple([z.number(), z.number()]),
  inputs: z.array(Socket),
  outputs: z.array(Socket),
  data: z.unknown(), // Refined below by type-aware parser.
  created_at: z.number().int().optional(),
  updated_at: z.number().int().optional(),
});
export type FlowNode = z.infer<typeof FlowNode>;

// Type-aware parser. Use this instead of FlowNode.parse() directly when
// you want strict validation on the known three types.
export function parseFlowNode(input: unknown): FlowNode {
  const shallow = FlowNode.parse(input);
  const known = NodeDataByType[shallow.type as keyof typeof NodeDataByType];
  const data = known ? known.parse(shallow.data) : PermissiveData.parse(shallow.data);
  return { ...shallow, data };
}

// Socket-id conventions. Generators only — useful when building nodes
// programmatically. When round-tripping an existing node, prefer the
// ids the server already assigned.
export const inputSocketId = (nodeNumber: number, i: number): string =>
  `ID_${nodeNumber}_${i}`;

export const outputSocketId = (nodeNumber: number, i: number): string =>
  `OD_${nodeNumber}_${i}`;

export const dataKey = (type: NodeType, nodeNumber: number): string =>
  `${type}_node_${nodeNumber}`;

// Output socket semantics for the two node types that branch. Both use
// the same convention.
//   0 = Completed
//   1 = Transfered  (sic — platform misspelling, preserved on the wire)
export const TRANSFER_OUTPUT_INDEX = 1;
export const COMPLETED_OUTPUT_INDEX = 0;

// Bridge input accepts either spelling; output to the wire is the
// platform's spelling.
export function isTransferBranch(label: string): boolean {
  const l = label.trim().toLowerCase();
  return l === "transfered" || l === "transferred";
}
