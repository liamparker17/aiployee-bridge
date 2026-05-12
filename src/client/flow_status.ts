/**
 * flow_status.ts — read-then-conditional-PATCH activation/deactivation.
 *
 * The PATCH /v1/flows/<uuid>/activate endpoint is a TOGGLE — calling it
 * always flips the current state. This module reads the current state via
 * listFlows and only PATCHes when the desired state differs from the actual
 * state, preventing accidental live-number flips.
 */

import type { Client } from "./index.js";
import { listFlows, getFlow, validateFlowLocal } from "../tools/flows.js";

export type FlowStatus = "Active" | "Inactive";

export interface SetFlowStatusResult {
  previousStatus: FlowStatus;
  newStatus: FlowStatus;
  changed: boolean;
  /** Inbound phone numbers that became live (activating) or stopped routing (deactivating). Empty when changed === false. */
  phoneNumbersAffected: string[];
}

export interface SetFlowStatusArgs {
  uuid: string;
  status: FlowStatus;
  /** MUST exactly equal the flow's current `name`. Prevents accidental activation. */
  confirm: string;
}

/**
 * Safely activate or deactivate a flow.
 *
 * Steps:
 * 1. listFlows → find the flow row (throws if missing).
 * 2. Confirm-token check (before validation calls).
 * 3. No-op short-circuit when status already matches.
 * 4. When activating: run local validation; check phone collisions with other Active flows.
 * 5. PATCH /flows/<uuid>/activate (toggle).
 * 6. Re-fetch to verify status actually flipped.
 * 7. Return result DTO.
 */
export async function setFlowStatus(
  c: Client,
  args: SetFlowStatusArgs,
): Promise<SetFlowStatusResult> {
  // --- Step 1: Read state ---
  const flows = await listFlows(c);
  const row = flows.find((f) => f.uuid === args.uuid);
  if (row === undefined) {
    throw new Error(`flow not found: ${args.uuid}`);
  }

  const previousStatus: FlowStatus = row.status;

  // --- Step 2: Confirm-token check (before any further network calls) ---
  if (args.confirm !== row.name) {
    throw new Error(
      `confirm token did not match the flow's name; expected '${row.name}' got '${args.confirm}'`,
    );
  }

  // --- Step 3: No-op short-circuit ---
  if (previousStatus === args.status) {
    return {
      previousStatus,
      newStatus: previousStatus,
      changed: false,
      phoneNumbersAffected: [],
    };
  }

  // Collect inbound phone numbers from this flow's nodes (needed for activate + deactivate return value)
  let thisFlowPhoneNumbers: string[] = [];

  // --- Step 4: Pre-activate checks (Inactive → Active only) ---
  if (args.status === "Active") {
    const dto = await getFlow(c, args.uuid, { name: row.name });

    // 4a. Local validation
    const issues = validateFlowLocal(dto);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      throw new Error(
        `flow has validation errors; cannot activate: ${JSON.stringify(errors)}`,
      );
    }

    // 4b. Collect this flow's inbound phone numbers
    for (const node of dto.nodes) {
      if (node.config.kind === "inbound_call") {
        for (const num of node.config.phoneNumbers) {
          thisFlowPhoneNumbers.push(num);
        }
      }
    }

    // 4c. Phone collision check against other Active flows
    if (thisFlowPhoneNumbers.length > 0) {
      const thisSet = new Set(thisFlowPhoneNumbers);
      const otherActiveFlows = flows.filter(
        (f) => f.uuid !== args.uuid && f.status === "Active",
      );

      type Collision = { number: string; otherName: string; otherUuid: string };
      const collisions: Collision[] = [];

      await Promise.all(
        otherActiveFlows.map(async (other) => {
          const otherDto = await getFlow(c, other.uuid, { name: other.name });
          for (const node of otherDto.nodes) {
            if (node.config.kind === "inbound_call") {
              for (const num of node.config.phoneNumbers) {
                if (thisSet.has(num)) {
                  collisions.push({ number: num, otherName: other.name, otherUuid: other.uuid });
                }
              }
            }
          }
        }),
      );

      if (collisions.length > 0) {
        const lines = collisions
          .map(
            (col) =>
              `  - number '${col.number}' is already claimed by Active flow '${col.otherName}' (${col.otherUuid})`,
          )
          .join("\n");
        throw new Error(
          `inbound phone collision: flow '${row.name}' (${args.uuid}) cannot activate because:\n${lines}\nDeactivate the conflicting flow(s) first if you intend to take over the number.`,
        );
      }
    }
  } else {
    // Deactivating — still collect phone numbers for the return value (no collision check needed)
    const dto = await getFlow(c, args.uuid, { name: row.name });
    for (const node of dto.nodes) {
      if (node.config.kind === "inbound_call") {
        for (const num of node.config.phoneNumbers) {
          thisFlowPhoneNumbers.push(num);
        }
      }
    }
  }

  // --- Step 5: Toggle ---
  await c.transport.request({
    method: "PATCH",
    path: `/flows/${args.uuid}/activate`,
    body: {},
  });

  // --- Step 6: Verify ---
  const verifyFlows = await listFlows(c);
  const verifyRow = verifyFlows.find((f) => f.uuid === args.uuid);
  if (!verifyRow) {
    throw new Error(
      `set_flow_status: flow '${args.uuid}' disappeared from listing after PATCH — was it deleted by another session?`,
    );
  }
  const actualStatus: FlowStatus = verifyRow.status;
  if (actualStatus !== args.status) {
    throw new Error(
      `toggle PATCH succeeded but flow status is still ${actualStatus}; possible server-side rejection or race`,
    );
  }

  // --- Step 7: Return ---
  return {
    previousStatus,
    newStatus: args.status,
    changed: true,
    phoneNumbersAffected: thisFlowPhoneNumbers,
  };
}
