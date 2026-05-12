/**
 * agents.ts — agent discovery helpers for the MCP tool surface.
 */

import type { Client } from "../client/index.js";
import type { AgentDetails, AgentUpdate } from "../client/agents.js";

export type { AgentDetails, AgentUpdate };

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

/**
 * Get a single agent's full details via the Yii edit form.
 * Requires Yii cookies in the auth file.
 */
export function getAgent(c: Client, uuid: string): Promise<AgentDetails> {
  return c.getAgent(uuid);
}

/**
 * Update an agent via the Yii edit form.
 * Only fields present in `update` are changed; all others retain current values.
 * Requires Yii cookies in the auth file.
 */
export function updateAgent(c: Client, update: AgentUpdate): Promise<void> {
  return c.updateAgent(update);
}
