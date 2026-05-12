/**
 * flows.ts — high-level flow operations for the MCP tool surface.
 *
 * These functions are library-usable without MCP — import them directly.
 * The wire GET /v1/flows/{uuid}/nodes does NOT return name/description, so
 * either pass `meta` to `getFlow` or allow it to call `listFlows` internally.
 */

import type { Client } from "../client/index.js";
import { ApiError } from "../schema/envelope.js";
import type { FlowDTO } from "../dto.js";
import type { ValidationIssue } from "../validate.js";
import { validateFlow } from "../validate.js";
import { fromWire, toWire } from "../normalize.js";

export interface FlowSummary {
  uuid: string;
  name: string;
  status: "Active" | "Inactive";
  modifiedAt: string | null;
}

/**
 * List all flows.
 *
 * Primary: GET /v1/flows (presumed endpoint — shape pending recon).
 * Fallback: scrape the Yii-rendered HTML listing page. The bearer token is
 * sent as `Cookie: access_token=<token>` but without PHPSESSID the Yii
 * session may not authenticate — the fallback is best-effort in headless mode.
 *
 * If both attempts fail, throws rather than returning an empty list.
 */
export async function listFlows(c: Client): Promise<FlowSummary[]> {
  // Primary: attempt the REST endpoint
  try {
    const result = await c.transport.request<unknown>({
      method: "GET",
      path: "/flows",
    });
    return parseFlowListResult(result);
  } catch (err) {
    // Fall back on 404 or 405 (unimplemented route), or on any ApiError whose
    // errors field is a string (non-JSON / HTML body). Any other error surfaces.
    if (
      !(
        err instanceof ApiError &&
        (err.httpStatus === 404 ||
          err.httpStatus === 405 ||
          typeof err.errors === "string")
      )
    ) {
      throw err;
    }
  }

  // Fallback: scrape the Yii HTML listing page
  console.warn(
    "[aiployee-bridge] GET /v1/flows returned 404 — falling back to HTML scrape of " +
      "https://aiployee.jobix.ai/flows (best-effort; may fail in headless mode)",
  );

  // The access_token cookie value equals the bearer token value.
  const token = c.transport.token;

  if (/[\r\n]/.test(token)) {
    throw new Error(
      "auth token contains illegal characters (CR/LF); rerun `aiployee-bridge auth`",
    );
  }

  let html: string;
  try {
    const res = await c.transport.fetchImpl("https://aiployee.jobix.ai/flows", {
      headers: {
        Cookie: `access_token=${token}`,
        Accept: "text/html",
      },
    });
    html = await res.text();
  } catch (fetchErr) {
    throw new Error(
      "listFlows: /v1/flows not yet recon'd; HTML fallback unavailable in headless mode — " +
        "capture this endpoint and rerun",
    );
  }

  return scrapeFlowsHtml(html);
}

/** Parse the result of GET /v1/flows into FlowSummary[]. */
function parseFlowListResult(result: unknown): FlowSummary[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const o = item as Record<string, unknown>;
    const uuid = typeof o.uuid === "string" ? o.uuid : null;
    const name = typeof o.name === "string" ? o.name : "";
    if (uuid === null) return [];
    const status: "Active" | "Inactive" =
      o.status === "Active" || o.status === 1 || o.status === true ? "Active" : "Inactive";
    const modifiedAt =
      typeof o.modifiedAt === "string"
        ? o.modifiedAt
        : typeof o.updated_at === "string"
          ? o.updated_at
          : typeof o.modified_at === "string"
            ? o.modified_at
            : null;
    return [{ uuid, name, status, modifiedAt }];
  });
}

/** Best-effort HTML scrape: extract flow rows from the Yii listing page. */
function scrapeFlowsHtml(html: string): FlowSummary[] {
  const summaries: FlowSummary[] = [];
  // Match <a href="/flows/<uuid>">…</a>
  const linkRe = /href="\/flows\/([0-9a-fA-F-]{36})"/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const uuid = m[1];
    if (uuid === undefined || seen.has(uuid)) continue;
    seen.add(uuid);
    summaries.push({ uuid, name: "(unknown — scraped from HTML)", status: "Inactive", modifiedAt: null });
  }
  return summaries;
}


/**
 * Fetch the full DTO for a flow by uuid.
 *
 * The wire GET /v1/flows/{uuid}/nodes returns only the node graph, not the
 * flow name or description. Pass `meta` (a partial FlowSummary) to avoid an
 * extra `listFlows` call; if omitted, `listFlows` is called automatically.
 * If that also fails, a minimal DTO with a placeholder name is returned.
 */
export async function getFlow(
  c: Client,
  uuid: string,
  meta?: Partial<FlowSummary>,
): Promise<FlowDTO> {
  const wireNodes = await c.getFlowNodes(uuid);

  let name: string;
  let description: string;

  if (meta !== undefined && typeof meta.name === "string") {
    name = meta.name;
    description = "";
  } else {
    // Try to resolve name from the list
    try {
      const flows = await listFlows(c);
      const found = flows.find((f) => f.uuid === uuid);
      name = found?.name ?? "(unknown — name not recon'd)";
      description = "";
    } catch {
      name = "(unknown — name not recon'd)";
      description = "";
    }
  }

  return fromWire({ uuid, name, description }, wireNodes);
}

/**
 * Validate and save a flow.
 *
 * Runs `validateFlow` locally first; throws if any issue has severity "error".
 * After `saveFlow` returns, the server may have renumbered nodes — re-fetch
 * the flow if you need the authoritative state.
 */
export async function updateFlow(c: Client, flow: FlowDTO): Promise<void> {
  const issues = validateFlow(flow);
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    throw new Error("flow has validation errors: " + JSON.stringify(errors));
  }
  await c.saveFlow(toWire(flow));
}

/**
 * Run local validation without network access.
 * Exposed here so callers don't need to import from `../validate.js` directly.
 */
export function validateFlowLocal(flow: FlowDTO): ValidationIssue[] {
  return validateFlow(flow);
}

export type { FlowStatus, SetFlowStatusArgs, SetFlowStatusResult } from "../client/flow_status.js";
import { setFlowStatus as _setFlowStatus } from "../client/flow_status.js";

/**
 * Activate or deactivate a flow safely.
 *
 * Reads current state first, confirms the token matches the flow name,
 * runs pre-activation validation and phone-collision detection, then
 * PATCHes the toggle endpoint only when a state change is actually needed.
 */
export function setFlowStatus(
  c: Client,
  args: import("../client/flow_status.js").SetFlowStatusArgs,
): Promise<import("../client/flow_status.js").SetFlowStatusResult> {
  return _setFlowStatus(c, args);
}
