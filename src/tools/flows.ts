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

  // Fallback: scrape the Yii HTML listing page using the YiiTransport,
  // which carries the full session cookie jar (PHPSESSID + _identity + _csrf).
  // A bare access_token cookie is not enough — Yii will 302 to /site/login.
  console.warn(
    "[aiployee-bridge] GET /v1/flows returned 404 — falling back to Yii HTML scrape of /flows",
  );

  let html: string;
  try {
    const res = await c.yiiTransport.fetchHtml("/flows");
    html = res.html;
  } catch (fetchErr) {
    throw new Error(
      `listFlows: /v1/flows unavailable and Yii HTML fallback failed: ${
        fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
      }`,
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

/**
 * Best-effort HTML scrape of the Yii flows GridView.
 *
 * Walks each <tr>…</tr> block that mentions a /flows/<uuid> link, then
 * pulls text out of the surrounding <td> cells and identifies each column
 * by content shape rather than position (status = "Active"/"Inactive";
 * modifiedAt = anything that looks like a date; name = the remaining text
 * cell that isn't "(not set)" or empty). This way the scraper survives
 * column reorders.
 */
function scrapeFlowsHtml(html: string): FlowSummary[] {
  const summaries: FlowSummary[] = [];
  const seen = new Set<string>();
  const uuidRe = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1] ?? "";
    const hrefMatch = /href="\/flows\/([0-9a-fA-F-]{36})"/i.exec(rowHtml);
    const keyMatch = uuidRe.exec(rowMatch[0] ?? "");
    const uuid = hrefMatch?.[1] ?? keyMatch?.[0];
    if (!uuid || seen.has(uuid)) continue;
    seen.add(uuid);

    const cellTexts: string[] = [];
    let cellMatch: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellMatch = cellRe.exec(rowHtml)) !== null) {
      cellTexts.push(decodeHtmlEntities(stripTags(cellMatch[1] ?? "")).trim());
    }

    let status: "Active" | "Inactive" = "Inactive";
    let modifiedAt: string | null = null;
    let name = "";

    const dateLike = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

    for (const text of cellTexts) {
      if (!text) continue;
      if (text === "Active" || text === "Inactive") {
        status = text;
        continue;
      }
      if (modifiedAt === null && dateLike.test(text) && /\d{4}/.test(text)) {
        modifiedAt = text;
        continue;
      }
      if (!name && text !== "(not set)" && !text.startsWith(uuid.slice(0, 8)) && text.length < 200) {
        name = text;
      }
    }

    summaries.push({
      uuid,
      name: name || "(unknown — scraped from HTML)",
      status,
      modifiedAt,
    });
  }

  return summaries;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}


/**
 * Fetch the full DTO for a flow by uuid.
 *
 * The wire GET /v1/flows/{uuid}/nodes returns only the node graph, not the
 * flow name or description. Pass `meta` (a partial FlowSummary) to avoid an
 * extra `listFlows` call; if omitted, `listFlows` is called automatically.
 * If that also fails, a minimal DTO with a placeholder name is returned.
 */
/**
 * Create a new (empty) flow with a name + optional description.
 *
 * Wire: POST https://aiployee.jobix.ai/flows/create (Yii ActiveForm).
 * Fields: SaveFlowForm[name], SaveFlowForm[description], _csrf.
 * Success: 302 redirect — Location may or may not embed the new UUID
 * depending on Yii version, so we resolve the UUID by listing flows
 * and matching on name. To avoid collisions we require the name not
 * already exist; if it does, the call fails fast rather than guessing.
 *
 * Returns { uuid, name } so callers can immediately drill in via
 * get_flow / update_flow.
 */
export async function createFlow(
  c: Client,
  name: string,
  description: string = "",
): Promise<{ uuid: string; name: string }> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("createFlow: name is required");
  }

  // Pre-check: refuse to create when the name is already in use, so the
  // post-create listFlows match has a unique target.
  const before = await listFlows(c);
  if (before.some((f) => f.name === trimmed)) {
    throw new Error(
      `createFlow: a flow named "${trimmed}" already exists — choose a unique name`,
    );
  }

  const form = await c.yiiTransport.getForm("/flows/create", {
    formId: "save-flow-form",
  });

  const result = await c.yiiTransport.submitForm(form, {
    "SaveFlowForm[name]": trimmed,
    "SaveFlowForm[description]": description,
  });

  if (result.status !== 302) {
    throw new Error(`createFlow: unexpected POST result HTTP ${result.status}`);
  }

  // Try to read the UUID directly out of the redirect Location first
  // (cheap path); fall back to listFlows match on name.
  const locMatch = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/.exec(
    result.finalUrl,
  );
  if (locMatch?.[0]) {
    return { uuid: locMatch[0], name: trimmed };
  }

  const after = await listFlows(c);
  const created = after.find((f) => f.name === trimmed);
  if (!created) {
    throw new Error(
      "createFlow: form submitted with HTTP 302 but the new flow did not appear in the listing — " +
        "the server may have silently rejected the create; check /flows in a browser",
    );
  }
  return { uuid: created.uuid, name: created.name };
}

/**
 * Delete a flow by UUID. Wire: POST /flows/<uuid>/delete on Yii.
 * Throws if the flow is missing or the server refuses (e.g. flow Active).
 */
export async function deleteFlow(c: Client, uuid: string): Promise<{ ok: true; uuid: string }> {
  if (!/^[0-9a-fA-F-]{36}$/.test(uuid)) {
    throw new Error("deleteFlow: uuid must be a 36-char UUID");
  }
  const result = await c.yiiTransport.postWithCsrf(`/flows/${encodeURIComponent(uuid)}/delete`);
  if (result.status !== 302) {
    throw new Error(`deleteFlow: server returned HTTP ${result.status} (expected 302)`);
  }
  return { ok: true, uuid };
}

/**
 * Catalog of every node `type` the bridge can round-trip, plus the
 * shape its `data` block expects. Returned by the list_node_types MCP
 * tool so callers building flows from scratch know what to put in
 * each NodeDTO.config without reading the bridge source.
 *
 * Two tiers:
 *   - "strict": data block is parsed by a known zod schema. Use these
 *     to build first-class flow logic.
 *   - "raw": data block is a passthrough — bridge accepts whatever the
 *     editor saves, and you build the JSON shape yourself.
 */
export interface NodeTypeInfo {
  type: string;
  tier: "strict" | "raw";
  configKind: string;
  dataShape: string;
}

export function listNodeTypes(): NodeTypeInfo[] {
  return [
    {
      type: "inbound_call",
      tier: "strict",
      configKind: "inbound_call",
      dataShape:
        "{ phoneNumbers: string[], cancelPrevExecuting: boolean, googleSheetsSync?: { enabled, sheetId, sheetName } }",
    },
    {
      type: "connect_call_agent",
      tier: "strict",
      configKind: "connect_call_agent",
      dataShape:
        "{ agentUuid: string, agentType: 'ai'|'real', copyAgent: boolean, prompt: string|null, phoneNumbers: string[], actions: unknown[] }",
    },
    {
      type: "call",
      tier: "strict",
      configKind: "call",
      dataShape:
        "{ agentUuid: string, copyAgent: boolean, prompt: string|null, phoneNumbers: string[], actions: unknown[], maxConcurrentExecuting: number|null, retryPolicy: { isActive, rules } }",
    },
    {
      type: "internet_call",
      tier: "raw",
      configKind: "internet_call",
      dataShape: "passthrough — raw object from the editor",
    },
    {
      type: "event",
      tier: "raw",
      configKind: "event",
      dataShape: "passthrough — trigger event (e.g. insert_customer)",
    },
    {
      type: "now",
      tier: "raw",
      configKind: "now",
      dataShape: "passthrough — immediate trigger",
    },
    {
      type: "split",
      tier: "raw",
      configKind: "split",
      dataShape: "passthrough — branching with percentages that must sum to 100",
    },
    {
      type: "delay",
      tier: "raw",
      configKind: "delay",
      dataShape: "passthrough — wait N seconds/minutes/hours",
    },
    {
      type: "filter",
      tier: "raw",
      configKind: "filter",
      dataShape: "passthrough — conditional gate on attributes",
    },
    {
      type: "update_data",
      tier: "raw",
      configKind: "update_data",
      dataShape: "passthrough — write contact attributes",
    },
    {
      type: "ai_data_generation",
      tier: "raw",
      configKind: "ai_data_generation",
      dataShape: "passthrough — LLM extraction node",
    },
    {
      type: "sms",
      tier: "raw",
      configKind: "sms",
      dataShape: "passthrough — outbound SMS",
    },
    {
      type: "email",
      tier: "raw",
      configKind: "email",
      dataShape: "passthrough — outbound email",
    },
    {
      type: "api_request",
      tier: "raw",
      configKind: "api_request",
      dataShape: "passthrough — outbound HTTP webhook",
    },
  ];
}

export async function getFlow(
  c: Client,
  uuid: string,
  meta?: Partial<FlowSummary>,
): Promise<FlowDTO> {
  // Resolve name up front from the list so the meta is correct even if
  // the node-graph endpoint fails.
  let name = "(unknown — name not recon'd)";
  let description = "";
  if (meta !== undefined && typeof meta.name === "string") {
    name = meta.name;
  } else {
    try {
      const flows = await listFlows(c);
      const found = flows.find((f) => f.uuid === uuid);
      if (found?.name) name = found.name;
    } catch {
      // swallow — fall through with placeholder name
    }
  }

  // Try the REST node-graph endpoint. If it fails (server returns a Yii
  // form error like "data_key required", a non-JSON HTML body, or a 404),
  // degrade to a meta-only DTO so callers can still inspect / list flows
  // without the call exploding. The description carries the failure so
  // the LLM can surface it.
  try {
    const wireNodes = await c.getFlowNodes(uuid);
    return fromWire({ uuid, name, description }, wireNodes);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      uuid,
      name,
      description:
        `(node graph unavailable — GET /flows/${uuid}/nodes failed: ${reason.slice(0, 300)})`,
      nodes: [],
      connections: [],
    };
  }
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
