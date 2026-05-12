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

export interface FlowNodesParseResult {
  nodes: FlowNode[];
  /**
   * Nodes the parser couldn't validate. They are kept here as raw
   * payloads so callers (and the LLM) can see them — never silently
   * dropped. Inspect via list_nodes if you need to operate on these.
   */
  dropped: Array<{
    uuid: string | null;
    type: string | null;
    number: number | null;
    reason: string;
    raw: unknown;
  }>;
}

export function parseFlowNodesResult(input: unknown): FlowNode[] {
  return parseFlowNodesResultDetailed(input).nodes;
}

/**
 * Same as parseFlowNodesResult but also surfaces every node the parser
 * couldn't validate. get_flow uses this to encode drop counts into the
 * FlowDTO description so the LLM can never assume an empty/partial
 * graph is the source of truth without first checking.
 */
export function parseFlowNodesResultDetailed(input: unknown): FlowNodesParseResult {
  if (!Array.isArray(input)) {
    throw new Error("expected array of nodes");
  }
  const nodes: FlowNode[] = [];
  const dropped: FlowNodesParseResult["dropped"] = [];
  for (let i = 0; i < input.length; i++) {
    try {
      nodes.push(parseFlowNode(input[i]));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const raw = input[i];
      const o = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<
        string,
        unknown
      >;
      dropped.push({
        uuid: typeof o.uuid === "string" ? o.uuid : null,
        type: typeof o.type === "string" ? o.type : null,
        number: typeof o.number === "number" ? o.number : null,
        reason: reason.slice(0, 400),
        raw,
      });
    }
  }
  return { nodes, dropped };
}
