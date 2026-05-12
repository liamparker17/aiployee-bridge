import { z } from "zod";
import { FlowNode, parseFlowNode } from "./node.js";

// The /v1/nodes/save request body.
export const SaveFlowRequest = z.object({
  flow_uuid: z.string().uuid(),
  flow_name: z.string(),
  flow_description: z.string(),
  nodes: z.array(FlowNode),
});
export type SaveFlowRequest = z.infer<typeof SaveFlowRequest>;

// The /v1/flows/{uuid}/nodes response payload (the `result` field of
// the envelope). Empty arrays are returned for empty flows.
export const FlowNodesResult = z.array(FlowNode);
export type FlowNodesResult = z.infer<typeof FlowNodesResult>;

export function parseFlowNodesResult(input: unknown): FlowNode[] {
  if (!Array.isArray(input)) {
    throw new Error("expected array of nodes");
  }
  // Per-node tolerance: one malformed node must not nuke the whole flow.
  // Bad nodes are skipped with a single warning; callers still see the
  // rest of the graph and can drill into specifics via validate_flow.
  const out: FlowNode[] = [];
  for (let i = 0; i < input.length; i++) {
    try {
      out.push(parseFlowNode(input[i]));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const raw = input[i];
      const ref =
        raw && typeof raw === "object" && "uuid" in raw
          ? (raw as { uuid: unknown }).uuid
          : `index ${i}`;
      console.warn(`[aiployee-bridge] dropping node ${String(ref)}: ${reason.slice(0, 200)}`);
    }
  }
  return out;
}
