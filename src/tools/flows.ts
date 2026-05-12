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
import { parseFlowNodesResultDetailed } from "../schema/flow.js";
import type { FlowNode } from "../schema/node.js";

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
 * Catalog of every node `type` the bridge can author, with a concrete
 * create_node payload example and per-type wiring rules.
 *
 * Knowledge captured here was recon'd by trial-and-error against the
 * live tenant — see /scripts/diag-* and the "Known recon gaps" section
 * of CLAUDE.md. The payload examples are what `create_node` actually
 * accepts; the constraints fields enforce what the server enforces.
 */
export interface NodeTypeInfo {
  type: string;
  tier: "strict" | "raw";
  configKind: string;
  /** Min/max output sockets enforced by the server. */
  outputs: { min: number; max: number; labels?: string[] };
  /** Required keys in the `data` block when calling create_node. */
  requiredDataKeys: string[];
  /**
   * Working create_node body example — copy, swap UUIDs/strings, send.
   * `flow_uuid`, `status`, `number`, `position` are universal and
   * already included. `data.data_key` follows the convention
   * `<type>_node_<number>` (server requires it).
   */
  createPayloadExample: Record<string, unknown>;
  /** Notes from real failure modes — read before authoring this type. */
  gotchas: string[];
}

export function listNodeTypes(): NodeTypeInfo[] {
  const baseStub = {
    flow_uuid: "<FLOW_UUID>",
    status: 1,
    number: 1,
    position: [200, 200], // [x, y] array — NOT {x, y}
  };

  return [
    {
      type: "inbound_call",
      tier: "strict",
      configKind: "inbound_call",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key", "phone_numbers", "cancel_prev_executing", "google_sheets_sync_data"],
      createPayloadExample: {
        ...baseStub,
        type: "inbound_call",
        name: "Inbound Trigger",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [],
        data: {
          data_key: "inbound_call_node_1",
          phone_numbers: ["+27000000000"],
          cancel_prev_executing: false,
          google_sheets_sync_data: { use_google_sync: false, google_sheet_id: null, google_sheet_name: null },
        },
      },
      gotchas: ["No inputs (it's a trigger).", "phone_numbers must be E.164 format."],
    },
    {
      type: "connect_call_agent",
      tier: "strict",
      configKind: "connect_call_agent",
      outputs: { min: 2, max: 2, labels: ["Completed", "Transferred"] },
      requiredDataKeys: ["data_key", "connect_agent_params", "actions"],
      createPayloadExample: {
        ...baseStub,
        type: "connect_call_agent",
        name: "Connect to agent",
        outputs: [
          { id: "OD_1_0", name: "Completed", connections: [] },
          { id: "OD_1_1", name: "Transferred", connections: [] },
        ],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: {
          data_key: "connect_call_agent_node_1",
          actions: [],
          connect_agent_params: {
            copy: false,
            type: "ai",            // "ai" | "real" — NOT agent_type/agentType
            uuid: "<AGENT_UUID>",  // NOT agent_uuid/agentUuid
            prompt: null,
            phone_numbers: [],
          },
        },
      },
      gotchas: [
        "connect_agent_params.type values: 'ai' or 'real' (not 'real_agent', 'agent_type', etc.).",
        "connect_agent_params.uuid — NOT agent_uuid / agentId / agentUuid.",
        "Output socket #1 is Transferred — the human-handoff branch.",
      ],
    },
    {
      type: "call",
      tier: "strict",
      configKind: "call",
      outputs: { min: 2, max: 2, labels: ["Completed", "Transferred"] },
      requiredDataKeys: ["data_key", "agent_params", "retry_policy", "actions"],
      createPayloadExample: {
        ...baseStub,
        type: "call",
        name: "Outbound call",
        outputs: [
          { id: "OD_1_0", name: "Completed", connections: [] },
          { id: "OD_1_1", name: "Transferred", connections: [] },
        ],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: {
          data_key: "call_node_1",
          actions: [],
          max_concurrent_executing: null,
          retry_policy: { is_active: false, rules: [] },
          agent_params: {
            copy: false,
            uuid: "<AGENT_UUID>",  // NOT agent_uuid
            prompt: null,
            phone_numbers: ["{{ attributes.phone }}"],
          },
        },
      },
      gotchas: [
        "agent_params.uuid (not agent_uuid). Different envelope key from connect_call_agent (connect_agent_params)!",
        "phone_numbers can use Jinja-style template expressions like {{ attributes.phone }}.",
        "retry_policy.rules entries: { attempts: int, interval_seconds: int }.",
      ],
    },
    {
      type: "event",
      tier: "raw",
      configKind: "event",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key", "filters"],
      createPayloadExample: {
        ...baseStub,
        type: "event",
        name: "On contact insert",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [],
        data: {
          data_key: "event_node_1",
          filters: [], // No conditions = fire on every matching event
          event_kind: "insert_customer", // observed values; check existing flows for others
        },
      },
      gotchas: ["No inputs (trigger).", "data.filters is the event-match filter, NOT the rich filter-node filters."],
    },
    {
      type: "filter",
      tier: "raw",
      configKind: "filter",
      outputs: { min: 2, max: 2, labels: ["True", "False"] },
      requiredDataKeys: ["data_key", "filters"],
      createPayloadExample: {
        ...baseStub,
        type: "filter",
        name: "Condition gate",
        outputs: [
          { id: "OD_1_0", name: "True", connections: [] },
          { id: "OD_1_1", name: "False", connections: [] },
        ],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: {
          data_key: "filter_node_1",
          // Rich filter rules — populate via update_node after create.
          // Rule ids must be ≤12 chars, e.g. "296091065803".
          filters: [],
        },
      },
      gotchas: [
        "create_node REJECTS rich filter rules ('Allowed only id, name, connections keys'). Create empty, populate via update_node.",
        "Filter rule ids must be ≤12 chars — existing flows use 12-digit numerics.",
      ],
    },
    {
      type: "ai_data_generation",
      tier: "raw",
      configKind: "ai_data_generation",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key", "llm_params", "json_mapper", "llm_credentials"],
      createPayloadExample: {
        ...baseStub,
        type: "ai_data_generation",
        name: "Extract structured data",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: {
          data_key: "ai_data_generation_node_1",
          llm_credentials: { provider: "openai", api_key: "<OPENAI_KEY>" },
          llm_params: { model: "gpt-4.1-mini", temperature: 0, system_prompt: "...", user_prompt: "{{ transcript }}" },
          json_mapper: { schema: { /* JSON schema */ }, output_attribute: "ai_extract_1" },
        },
      },
      gotchas: [
        "llm_credentials.api_key is plaintext on the wire — prefer an integration credential.",
        "output_attribute is what later nodes reference (e.g. ai_extract_4.needs_assistance).",
      ],
    },
    {
      type: "api_request",
      tier: "raw",
      configKind: "api_request",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key", "request"],
      createPayloadExample: {
        ...baseStub,
        type: "api_request",
        name: "Webhook",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: {
          data_key: "api_request_node_1",
          request: {
            method: "POST",
            url: "https://example.com/webhook",
            headers: {},
            body: { /* template expressions allowed */ },
            retry: { attempts: 3, delay_seconds: 30 },
          },
        },
      },
      gotchas: ["Outputs are capped at 1 — no per-status branching."],
    },
    {
      type: "sms",
      tier: "raw",
      configKind: "sms",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key", "sms_params"],
      createPayloadExample: {
        ...baseStub,
        type: "sms",
        name: "Send SMS",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: {
          data_key: "sms_node_1",
          sms_params: {
            provider_slug: "<provider>", // common: twilio, clickatell, infobip, mymobileapi
            to: "{{ attributes.phone }}",
            message: "Hello",
          },
        },
      },
      gotchas: [
        "provider_slug is required and must match a provider configured on the tenant.",
        "Ask the user which SMS provider is wired up — no default.",
      ],
    },
    {
      type: "update_data",
      tier: "raw",
      configKind: "update_data",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key", "actions"],
      createPayloadExample: {
        ...baseStub,
        type: "update_data",
        name: "Set attributes",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: {
          data_key: "update_data_node_1",
          actions: [
            // { attribute_slug: "first_name", value: "{{ ai_extract_1.first_name }}" }
          ],
        },
      },
      gotchas: ["Attribute slugs must exist — call list_custom_fields first."],
    },
    {
      type: "delay",
      tier: "raw",
      configKind: "delay",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key", "delay_params"],
      createPayloadExample: {
        ...baseStub,
        type: "delay",
        name: "Wait",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: { data_key: "delay_node_1", delay_params: { amount: 5, unit: "minutes" } },
      },
      gotchas: [],
    },
    {
      type: "split",
      tier: "raw",
      configKind: "split",
      outputs: { min: 2, max: 10 },
      requiredDataKeys: ["data_key", "branches"],
      createPayloadExample: {
        ...baseStub,
        type: "split",
        name: "A/B split",
        outputs: [
          { id: "OD_1_0", name: "A", connections: [] },
          { id: "OD_1_1", name: "B", connections: [] },
        ],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: { data_key: "split_node_1", branches: [{ percentage: 50 }, { percentage: 50 }] },
      },
      gotchas: ["Branch percentages must sum to 100."],
    },
    {
      type: "email",
      tier: "raw",
      configKind: "email",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key", "email_params"],
      createPayloadExample: {
        ...baseStub,
        type: "email",
        name: "Send email",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [{ id: "ID_1_0", name: null, connections: [] }],
        data: { data_key: "email_node_1", email_params: { to: "", subject: "", body_html: "" } },
      },
      gotchas: [],
    },
    {
      type: "now",
      tier: "raw",
      configKind: "now",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key"],
      createPayloadExample: {
        ...baseStub,
        type: "now",
        name: "Run immediately",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [],
        data: { data_key: "now_node_1" },
      },
      gotchas: ["No inputs (trigger)."],
    },
    {
      type: "internet_call",
      tier: "raw",
      configKind: "internet_call",
      outputs: { min: 1, max: 1 },
      requiredDataKeys: ["data_key"],
      createPayloadExample: {
        ...baseStub,
        type: "internet_call",
        name: "Web widget trigger",
        outputs: [{ id: "OD_1_0", name: "Completed", connections: [] }],
        inputs: [],
        data: { data_key: "internet_call_node_1" },
      },
      gotchas: ["No inputs (trigger). Fires when the widget call begins."],
    },
  ];
}

/**
 * Compute the conventional socket id for a node.
 * Pattern (server-enforced): OD_<node_number>_<index>, ID_<node_number>_<index>.
 */
export function socketId(direction: "input" | "output", nodeNumber: number, index: number): string {
  return `${direction === "output" ? "OD" : "ID"}_${nodeNumber}_${index}`;
}

/**
 * Wire a single connection between two existing nodes.
 *
 * Sends the change as a `PUT /v1/nodes/<from_uuid>` rather than a bulk
 * `POST /v1/nodes/save`. The bulk endpoint deletes-and-recreates every
 * node it receives, which mints fresh UUIDs for the source — forcing
 * callers to re-fetch list_nodes between every connect call. The
 * single-node PUT keeps the from-node's identity stable.
 *
 * If the server still rotates the UUID for some reason, the new value
 * is surfaced in `new_from_node_uuid` so callers can chain without
 * relisting. Target nodes have always been stable.
 *
 * Idempotent — re-running with the same args is a no-op.
 */
export async function connectNodes(
  c: Client,
  args: {
    flow_uuid: string;
    from_node_uuid: string;
    from_output_index: number;
    to_node_uuid: string;
    to_input_index?: number; // default 0
  },
): Promise<{
  ok: true;
  from_socket: string;
  to_socket: string;
  new_from_node_uuid: string;
  uuid_rotated: boolean;
}> {
  const toInputIndex = args.to_input_index ?? 0;
  const result = await mutateSourceConnections(c, args.flow_uuid, args.from_node_uuid, (outputs, toNode) => {
    const fromOutput = outputs[args.from_output_index];
    if (!fromOutput) {
      throw new Error(
        `connectNodes: source node has no output #${args.from_output_index} (it has ${outputs.length} outputs)`,
      );
    }
    const toInput = toNode.inputs[toInputIndex];
    if (!toInput) {
      throw new Error(
        `connectNodes: target node has no input #${toInputIndex} (it has ${toNode.inputs.length} inputs)`,
      );
    }
    const already = fromOutput.connections.some(
      (c) => c.node_number === toNode.number && c.node_socket === toInput.id,
    );
    if (!already) {
      fromOutput.connections.push({ node_number: toNode.number, node_socket: toInput.id });
    }
    return { from_socket: fromOutput.id, to_socket: toInput.id };
  }, args.to_node_uuid);
  return { ok: true, ...result };
}

/**
 * Remove a single connection between two nodes (surgical edge delete).
 * Same wire mechanics as connect_nodes — single-node PUT, returns the
 * new from-node UUID if the server rotated it.
 *
 * Pass `from_output_index` to scope the removal to one output socket,
 * or omit it to remove every connection from any output of the source
 * node that targets the given to-node.
 */
export async function disconnectNodes(
  c: Client,
  args: {
    flow_uuid: string;
    from_node_uuid: string;
    to_node_uuid: string;
    from_output_index?: number; // optional — scope to one output
  },
): Promise<{
  ok: true;
  removed: Array<{ from_socket: string; to_socket: string }>;
  new_from_node_uuid: string;
  uuid_rotated: boolean;
}> {
  const result = await mutateSourceConnections(
    c,
    args.flow_uuid,
    args.from_node_uuid,
    (outputs, toNode) => {
      const removed: Array<{ from_socket: string; to_socket: string }> = [];
      const targetIndices =
        args.from_output_index !== undefined
          ? [args.from_output_index]
          : outputs.map((_, i) => i);
      for (const i of targetIndices) {
        const out = outputs[i];
        if (!out) continue;
        out.connections = out.connections.filter((c) => {
          const matches = c.node_number === toNode.number;
          if (matches) removed.push({ from_socket: out.id, to_socket: c.node_socket });
          return !matches;
        });
      }
      return { removed };
    },
    args.to_node_uuid,
  );
  return {
    ok: true,
    removed: result.removed,
    new_from_node_uuid: result.new_from_node_uuid,
    uuid_rotated: result.uuid_rotated,
  };
}

/**
 * Shared mechanic for connect/disconnect: read the source node, let the
 * caller mutate its outputs in place, PUT it back as a single-node
 * update. Surfaces UUID rotation if the server changes it.
 */
async function mutateSourceConnections<T>(
  c: Client,
  flowUuid: string,
  fromNodeUuid: string,
  mutate: (outputs: FlowNode["outputs"], toNode: FlowNode) => T,
  toNodeUuid: string,
): Promise<T & { new_from_node_uuid: string; uuid_rotated: boolean }> {
  const nodes = await c.getFlowNodes(flowUuid);
  const fromNode = nodes.find((n) => n.uuid === fromNodeUuid);
  const toNode = nodes.find((n) => n.uuid === toNodeUuid);
  if (!fromNode) throw new Error(`mutateSourceConnections: from ${fromNodeUuid} not found`);
  if (!toNode) throw new Error(`mutateSourceConnections: to ${toNodeUuid} not found`);

  const mutateResult = mutate(fromNode.outputs, toNode);

  // Single-node PUT. We must include flow_uuid in the body (server
  // returns "Flow not found" otherwise — see update_node tool).
  const response = (await c.updateNode(fromNode.uuid, {
    flow_uuid: flowUuid,
    name: fromNode.name,
    type: fromNode.type,
    status: fromNode.status,
    number: fromNode.number,
    position: fromNode.position,
    inputs: fromNode.inputs,
    outputs: fromNode.outputs,
    data: fromNode.data,
  })) as { uuid?: string } | unknown;

  const newUuid =
    response && typeof response === "object" && "uuid" in response && typeof (response as { uuid: unknown }).uuid === "string"
      ? (response as { uuid: string }).uuid
      : fromNodeUuid;

  return {
    ...mutateResult,
    new_from_node_uuid: newUuid,
    uuid_rotated: newUuid !== fromNodeUuid,
  };
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

  // Try the REST node-graph endpoint. Three failure modes:
  //   1. Network/HTTP error → degrade to meta-only DTO
  //   2. Strict parser drops nodes → surface the drop count in `description`
  //      so the LLM never assumes "2 nodes returned" means "2 nodes exist"
  //   3. fromWire drops nodes (unknown type / bad shape) → same treatment
  try {
    const raw = await c.getFlowNodesRaw(uuid);
    const detailed = parseFlowNodesResultDetailed(raw);
    const dto = fromWire({ uuid, name, description }, detailed.nodes);

    const expectedCount = Array.isArray(raw) ? raw.length : detailed.nodes.length;
    const returnedCount = dto.nodes.length;
    if (expectedCount !== returnedCount || detailed.dropped.length > 0) {
      const dropSummaries = detailed.dropped
        .map((d) => `  - ${d.uuid ?? "(no uuid)"} type=${d.type} number=${d.number}: ${d.reason}`)
        .join("\n");
      const downstreamDropped = expectedCount - returnedCount - detailed.dropped.length;
      dto.description =
        `[WARN] server returned ${expectedCount} nodes; bridge parsed ${returnedCount}. ` +
        `${detailed.dropped.length} dropped by schema, ${downstreamDropped} by fromWire. ` +
        `Use list_nodes(${uuid}) for the raw passthrough view.` +
        (dropSummaries ? `\n${dropSummaries}` : "") +
        (description ? `\n${description}` : "");
    }
    return dto;
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
 * Ground-truth flat manifest of every node the server has for a flow.
 *
 * Returns the raw wire shape from /v1/flows/<uuid>/nodes with NO schema
 * parsing, so it survives any current or future schema drift. Use this
 * whenever you suspect get_flow is under-reporting (it can, if the
 * strict zod schemas miss a new field shape — they degrade per-node
 * with a warning that the LLM can't see otherwise).
 *
 * Returns one entry per node with the most-useful identification fields
 * plus the raw payload. Sorted by node `number` ascending.
 */
export async function listNodes(
  c: Client,
  flowUuid: string,
  opts: { brief?: boolean } = {},
): Promise<
  Array<{
    uuid: string;
    type: string;
    number: number;
    name: string;
    status: number;
    inputs_count: number;
    outputs_count: number;
    raw?: unknown;
  }>
> {
  const raw = await c.getFlowNodesRaw(flowUuid);
  if (!Array.isArray(raw)) {
    throw new Error("listNodes: server did not return an array");
  }
  const entries = raw.map((n: unknown) => {
    const o = (n && typeof n === "object" ? (n as Record<string, unknown>) : {}) as Record<
      string,
      unknown
    >;
    const inputs = Array.isArray(o.inputs) ? o.inputs : [];
    const outputs = Array.isArray(o.outputs) ? o.outputs : [];
    const entry: {
      uuid: string;
      type: string;
      number: number;
      name: string;
      status: number;
      inputs_count: number;
      outputs_count: number;
      raw?: unknown;
    } = {
      uuid: typeof o.uuid === "string" ? o.uuid : "",
      type: typeof o.type === "string" ? o.type : "",
      number: typeof o.number === "number" ? o.number : -1,
      name: typeof o.name === "string" ? o.name : "",
      status: typeof o.status === "number" ? o.status : -1,
      inputs_count: inputs.length,
      outputs_count: outputs.length,
    };
    if (!opts.brief) entry.raw = n;
    return entry;
  });
  entries.sort((a, b) => a.number - b.number);
  return entries;
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
