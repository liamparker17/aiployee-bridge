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
  return input.map(parseFlowNode);
}
