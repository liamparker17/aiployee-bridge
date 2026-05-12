import { type FlowDTO, TRIGGER_TYPES } from "./dto.js";

// Local validators run before any `POST /v1/nodes/save`. The goal is to
// catch problems the bridge can know about without a round-trip; the
// server still has the final say.
//
// The shape of each issue matches the server's `errors[]` so callers
// can render local and server errors uniformly.

export type Severity = "error" | "warning";

export interface ValidationIssue {
  /** DTO node uuid, or `null` for flow-level issues. */
  node_id: string | null;
  severity: Severity;
  message: string;
}

export function validateFlow(flow: FlowDTO): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byUuid = new Map(flow.nodes.map((n) => [n.uuid ?? "", n] as const));

  // 1. Exactly one trigger.
  const triggers = flow.nodes.filter((n) => TRIGGER_TYPES.has(n.config.kind));
  if (triggers.length === 0) {
    issues.push({
      node_id: null,
      severity: "error",
      message: "flow has no trigger node — add one of: " + Array.from(TRIGGER_TYPES).join(", "),
    });
  } else if (triggers.length > 1) {
    for (const t of triggers.slice(1)) {
      issues.push({
        node_id: t.uuid,
        severity: "error",
        message: `flow has ${triggers.length} trigger nodes; only one is allowed`,
      });
    }
  }

  // 2. Connection endpoints must exist.
  for (const c of flow.connections) {
    if (!byUuid.has(c.fromNode)) {
      issues.push({
        node_id: c.fromNode,
        severity: "error",
        message: `connection references unknown source node ${c.fromNode}`,
      });
    }
    if (!byUuid.has(c.toNode)) {
      issues.push({
        node_id: c.toNode,
        severity: "error",
        message: `connection references unknown target node ${c.toNode}`,
      });
    }
  }

  // 3. Per-node required-field checks for the three known config kinds.
  for (const n of flow.nodes) {
    switch (n.config.kind) {
      case "inbound_call":
        if (n.config.phoneNumbers.length === 0) {
          issues.push({
            node_id: n.uuid,
            severity: "error",
            message: `Inbound Call node "${n.name}" has no phone numbers — add at least one`,
          });
        }
        break;
      case "connect_call_agent":
      case "call":
        if (!n.config.agentUuid) {
          issues.push({
            node_id: n.uuid,
            severity: "error",
            message: `${n.config.kind} node "${n.name}" has no agent configured`,
          });
        }
        break;
      default:
        // Permissive — server validates these until per-type recon lands.
        break;
    }
  }

  return issues;
}

/**
 * Convenience predicate: returns true when `validateFlow` would surface
 * no `error`-severity issues. Use this before activating a flow.
 */
export function hasBlockingErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

// --- Phone-number normalisation ---

/**
 * Loose normalisation for South African mobile/landline numbers entered
 * with a leading 0. Wire format is always E.164.
 *
 * - `0877295318`  → `+27877295318`
 * - `+27877295318` → unchanged
 * - anything else (already starts with `+`, or non-numeric) is returned
 *   as-is. The server has the final say on validity.
 *
 * This is deliberately conservative: the bridge never silently rewrites
 * an unrecognised number into a valid-looking one.
 */
export function normalizeZaPhoneNumber(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("+")) return trimmed;
  if (/^0[0-9]{8,9}$/.test(trimmed)) return `+27${trimmed.slice(1)}`;
  return trimmed;
}
