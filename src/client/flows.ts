import { Transport } from "./transport.js";
import {
  parseFlowNodesResult,
  SaveFlowRequest,
  type FlowNode,
} from "../schema/index.js";

/** Read the full node graph of a flow. */
export async function getFlowNodes(t: Transport, uuid: string): Promise<FlowNode[]> {
  const raw = await t.request<unknown>({
    method: "GET",
    path: `/flows/${encodeURIComponent(uuid)}/nodes`,
  });
  return parseFlowNodesResult(raw);
}

/**
 * Save (full-replace) a flow's graph.
 *
 * The server replaces `nodes` wholesale — there is no per-node PATCH.
 * Validation failures come back as HTTP 200 with success:false, which
 * Transport re-raises as ApiError before this function returns.
 */
export async function saveFlow(t: Transport, req: SaveFlowRequest): Promise<void> {
  // Validate locally before hitting the wire. Throws on missing fields,
  // bad uuids, malformed sockets, etc.
  const validated = SaveFlowRequest.parse(req);
  await t.request<unknown>({
    method: "POST",
    path: "/nodes/save",
    body: validated,
  });
}
