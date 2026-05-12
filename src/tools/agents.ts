/**
 * agents.ts — agent discovery helpers for the MCP tool surface.
 */

import type { Client } from "../client/index.js";

export interface AgentSummary {
  uuid: string;
  name: string;
}

/**
 * List all AI agents available on the tenant.
 *
 * Wraps `c.listAgents()` (GET /v1/r/agents-dropdown). The `value` field
 * on each dropdown option is the agent uuid (verified in recon).
 *
 * Note: `/v1/r/widgets-dropdown` (reachable via `c.listWidgets()`) also
 * returns an agents-like list; the two endpoints may differ. Per recon, the
 * difference is not yet known — this function wraps `agents-dropdown` only.
 * Call `c.listWidgets()` directly if you need the widgets variant.
 */
export async function listAgents(c: Client): Promise<AgentSummary[]> {
  const options = await c.listAgents();
  return options.map((opt) => ({
    uuid: opt.value,
    name: opt.label,
  }));
}
