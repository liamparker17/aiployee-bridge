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
 * Create a single new node attached to an existing flow. The server
 * mints the node's UUID and `number`; the returned wire-node carries
 * them so callers can wire connections against the real identity.
 *
 * `body` is a partial wire-node — at minimum `{flow_uuid, type, data}`.
 * Position, name, status, etc. fall back to server defaults if omitted.
 * The exact shape the editor emits is `event.detail` from the nodular
 * web component, which we can't read directly; if the server rejects
 * a field, the error surfaces verbatim via ApiError.
 */
export async function createNode(t: Transport, body: Record<string, unknown>): Promise<unknown> {
  return await t.request<unknown>({
    method: "POST",
    path: "/nodes",
    body,
  });
}

/**
 * Replace a single existing node by UUID. Use when the LLM wants to
 * tweak one node's `data` without re-sending the whole flow.
 */
export async function updateNode(
  t: Transport,
  uuid: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return await t.request<unknown>({
    method: "PUT",
    path: `/nodes/${encodeURIComponent(uuid)}`,
    body,
  });
}

/**
 * Delete a single node by UUID. Connections that referenced the node
 * are cleaned up server-side.
 */
export async function deleteNode(t: Transport, uuid: string): Promise<unknown> {
  return await t.request<unknown>({
    method: "DELETE",
    path: `/nodes/${encodeURIComponent(uuid)}`,
  });
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
