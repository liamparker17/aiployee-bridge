/**
 * numbers.ts — phone number pool helpers for the MCP tool surface.
 */

import type { Client } from "../client/index.js";

export type PhoneNumberKind = "inbound" | "outbound" | "human";

export interface PhoneNumberInfo {
  /** E.164 format */
  number: string;
  kind: PhoneNumberKind;
  label: string;
  /** Present for outbound numbers when the pool entry carries an agent_uuid. */
  ownerAgentUuid?: string;
}

/**
 * List all phone numbers from all three pool variants in parallel.
 *
 * Deduplication is by (number, kind) only — the same number appearing in
 * multiple kinds (e.g. both inbound and outbound) is kept as separate entries
 * so the caller can see it is available for multiple uses.
 */
export async function listPhoneNumbers(c: Client): Promise<PhoneNumberInfo[]> {
  const [inbound, outbound, human] = await Promise.all([
    c.listPhoneNumberPool("inbound_call"),
    c.listPhoneNumberPool("outbound_call"),
    c.listPhoneNumberPool("human_agent"),
  ]);

  const results: PhoneNumberInfo[] = [];
  const seen = new Set<string>();

  const add = (number: string, kind: PhoneNumberKind, label: string, ownerAgentUuid?: string) => {
    const key = `${number}|${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    const info: PhoneNumberInfo = { number, kind, label };
    if (ownerAgentUuid !== undefined) {
      info.ownerAgentUuid = ownerAgentUuid;
    }
    results.push(info);
  };

  for (const entry of inbound) {
    add(entry.value, "inbound", entry.label);
  }

  for (const entry of outbound) {
    add(entry.value, "outbound", entry.label, entry.agent_uuid ?? undefined);
  }

  for (const entry of human) {
    add(entry.value, "human", entry.label);
  }

  return results;
}
