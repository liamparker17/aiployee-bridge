#!/usr/bin/env node
/**
 * mcp-server.ts — stdio MCP server exposing AIployee Flows as tool calls.
 *
 * Usage:
 *   aiployee-bridge               — start the MCP server (reads/writes on stdio)
 *   aiployee-bridge auth [flags]  — write auth.json and exit
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Client } from "./client/index.js";
import {
  listFlows,
  getFlow,
  createFlow,
  deleteFlow,
  updateFlow,
  validateFlowLocal,
  setFlowStatus,
  listNodeTypes,
  connectNodes,
  listNodes,
} from "./tools/flows.js";
import { listAgents, getAgent, updateAgent } from "./tools/agents.js";
import { listCustomFields, upsertCustomField, deleteCustomField } from "./tools/custom_fields.js";
import { getContact, updateContactAttribute } from "./tools/contacts.js";
import { listPhoneNumbers } from "./tools/numbers.js";
import { listFlowRuns, getFlowRun } from "./tools/flow_runs.js";
import { runFlowTest } from "./tools/test_widget.js";
import { FlowDTO } from "./dto.js";

async function main(): Promise<void> {
  // ---------- auth subcommand ----------
  if (process.argv[2] === "auth") {
    const { runAuthCli } = await import("./auth-cli.js");
    await runAuthCli(process.argv.slice(3));
    return;
  }

  // ---------- load auth ----------
  let client: Client;
  try {
    client = await Client.fromAuthFile();
  } catch (err) {
    const msg =
      err instanceof Error && err.message.includes("auth file not found")
        ? err.message
        : `aiployee-bridge: no auth — run \`aiployee-bridge auth --token <value>\` first`;
    process.stderr.write(msg + "\n");
    process.exit(1);
  }

  // ---------- build server ----------
  const server = new McpServer({
    name: "aiployee-bridge",
    version: "0.1.0",
  });

  // Helper: wrap result as MCP content array
  function ok(value: unknown): { content: [{ type: "text"; text: string }] } {
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
  }

  // Helper: convert Error to MCP text content (isError flag signals failure to caller).
  // ApiError's `errors` field carries the server's validation breakdown — surface it
  // verbatim so the LLM sees the exact field/key it tripped on instead of just the top
  // line. This pattern (rich pass-through) is load-bearing for iterative authoring.
  function fail(err: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
    let payload: unknown;
    if (err instanceof Error) {
      const errors = (err as { errors?: unknown }).errors;
      const httpStatus = (err as { httpStatus?: unknown }).httpStatus;
      const endpoint = (err as { endpoint?: unknown }).endpoint;
      payload = errors !== undefined || httpStatus !== undefined
        ? { message: err.message, httpStatus, endpoint, errors }
        : err.message;
    } else {
      payload = String(err);
    }
    const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    return { isError: true as const, content: [{ type: "text" as const, text }] };
  }

  // Auto-fill socket ids when the caller passes outputs/inputs as bare
  // label strings. The server's id format is rigid:
  //   outputs: OD_<node_number>_<index>
  //   inputs:  ID_<node_number>_<index>
  // Letting the LLM say `outputs: ["Completed", "Transferred"]` is far
  // less error-prone than asking it to construct those strings.
  function normalizeCreateNodeBody(body: Record<string, unknown>): Record<string, unknown> {
    const out = { ...body };
    const num = typeof out.number === "number" ? out.number : 1;
    if (Array.isArray(out.outputs)) {
      out.outputs = out.outputs.map((entry, i) => {
        if (typeof entry === "string") {
          return { id: `OD_${num}_${i}`, name: entry, connections: [] };
        }
        if (entry && typeof entry === "object" && !("id" in entry)) {
          return { id: `OD_${num}_${i}`, connections: [], ...entry };
        }
        return entry;
      });
    }
    if (Array.isArray(out.inputs)) {
      out.inputs = out.inputs.map((entry, i) => {
        if (typeof entry === "string") {
          return { id: `ID_${num}_${i}`, name: entry, connections: [] };
        }
        if (entry && typeof entry === "object" && !("id" in entry)) {
          return { id: `ID_${num}_${i}`, connections: [], ...entry };
        }
        return entry;
      });
    }
    return out;
  }

  // --- list_flows ---
  server.tool("list_flows", "List all AIployee flows.", async () => {
    try {
      const result = await listFlows(client);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  // --- get_flow ---
  server.tool(
    "get_flow",
    "Get a flow's full DTO by UUID.",
    { uuid: z.string().uuid() },
    async ({ uuid }) => {
      try {
        const result = await getFlow(client, uuid);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- create_flow ---
  server.tool(
    "create_flow",
    "Create a new empty flow. Returns {uuid, name}. After creating, call update_flow to populate the node graph. Name must be unique within the workspace.",
    {
      name: z.string().min(1, "name required"),
      description: z.string().default(""),
    },
    async ({ name, description }) => {
      try {
        const result = await createFlow(client, name, description);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- update_flow ---
  server.tool(
    "update_flow",
    "Validate and save a flow DTO. Returns {ok: true} on success. Use create_flow first to get a uuid; then call this with the full FlowDTO (nodes + connections).",
    { flow: FlowDTO },
    async ({ flow }) => {
      try {
        await updateFlow(client, flow);
        return ok({ ok: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- list_nodes ---
  // Ground-truth manifest. get_flow's strict parser can silently drop
  // nodes when a schema field doesn't match — list_nodes bypasses
  // parsing entirely and returns every node the server has. Use this
  // whenever you suspect "what I see in the UI" disagrees with what
  // get_flow returned.
  server.tool(
    "list_nodes",
    "Flat raw manifest of every node attached to a flow. No schema parsing — survives any current or future drift. Returns {uuid, type, number, name, status, inputs_count, outputs_count, raw} per node. Call this when get_flow's count looks wrong.",
    { flow_uuid: z.string().uuid() },
    async ({ flow_uuid }) => {
      try {
        const result = await listNodes(client, flow_uuid);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- create_node ---
  // The save-whole-flow endpoint (used by update_flow) requires every
  // node UUID to already exist server-side. To author a brand-new flow
  // from scratch the LLM must mint each node here first, collect the
  // returned UUIDs, then wire connections via connect_nodes or update_flow.
  //
  // Quality-of-life: if the caller passes outputs/inputs as bare label
  // strings (e.g. ["Completed", "Transferred"]) the bridge synthesises
  // the OD_<number>_<i> / ID_<number>_<i> socket ids automatically,
  // so the LLM never has to construct the server's id format by hand.
  server.tool(
    "create_node",
    "Mint a single new node. POSTs /v1/nodes; server returns the new node with a real UUID and `number`. Use list_node_types first to see the working payload example for each type — copy it, swap UUIDs/strings, and send. Outputs/inputs accept either full socket objects {id, name, connections} OR bare label strings (the bridge auto-fills socket ids).",
    {
      body: z.record(z.string(), z.unknown()),
    },
    async ({ body }) => {
      try {
        const normalised = normalizeCreateNodeBody(body);
        const result = await client.createNode(normalised);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- update_node ---
  server.tool(
    "update_node",
    "Replace a single node's config in place by UUID. PUTs /v1/nodes/<uuid>. Use this for surgical edits and for populating filter rules (create_node rejects rich filter shapes, update_node accepts them). IMPORTANT: body must include flow_uuid — the server returns 'Flow not found' if it's missing, which is misleading.",
    {
      uuid: z.string().uuid(),
      body: z.record(z.string(), z.unknown()),
    },
    async ({ uuid, body }) => {
      try {
        if (!body.flow_uuid || typeof body.flow_uuid !== "string") {
          throw new Error(
            "update_node: body.flow_uuid is required. The server's 'Flow not found' error fires when it's missing — surface this clearly so the LLM knows what to fix.",
          );
        }
        const result = await client.updateNode(uuid, body);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- connect_nodes ---
  server.tool(
    "connect_nodes",
    "Wire a single connection between two existing nodes. Bridge fetches current state, mutates the source output socket's connections array, and saves. Idempotent. Use this for incremental wiring instead of assembling a full FlowDTO. Socket IDs are computed automatically — pass output INDEX (0=first output, e.g. Completed; 1=second, e.g. Transferred or False) not the OD_N_M string.",
    {
      flow_uuid: z.string().uuid(),
      from_node_uuid: z.string().uuid(),
      from_output_index: z.number().int().min(0),
      to_node_uuid: z.string().uuid(),
      to_input_index: z.number().int().min(0).default(0),
    },
    async (args) => {
      try {
        const result = await connectNodes(client, args);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- delete_node ---
  server.tool(
    "delete_node",
    "Delete a single node by UUID. DELETEs /v1/nodes/<uuid>. Connections that referenced it are cleaned up server-side.",
    { uuid: z.string().uuid() },
    async ({ uuid }) => {
      try {
        const result = await client.deleteNode(uuid);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- delete_flow ---
  server.tool(
    "delete_flow",
    "Delete a flow permanently by UUID. Active flows may need to be deactivated first via set_flow_status. Returns {ok: true, uuid}.",
    { uuid: z.string().uuid() },
    async ({ uuid }) => {
      try {
        const result = await deleteFlow(client, uuid);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- list_node_types ---
  server.tool(
    "list_node_types",
    "Catalog of every node `type` value the bridge supports + the shape of its config/data block. Call this first when building a flow from scratch so you know what to put in each node's `config` field.",
    async () => {
      try {
        return ok(listNodeTypes());
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- validate_flow ---
  server.tool(
    "validate_flow",
    "Run local validation on a flow DTO without saving. Returns an array of ValidationIssue.",
    { flow: FlowDTO },
    async ({ flow }) => {
      try {
        const issues = await validateFlowLocal(flow);
        return ok(issues);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- list_agents ---
  server.tool("list_agents", "List all available agents.", async () => {
    try {
      const result = await listAgents(client);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  // --- get_agent ---
  server.tool(
    "get_agent",
    "Get a single AI agent's full details (prompts, phone numbers, knowledge, etc.) by UUID.",
    { uuid: z.string().uuid() },
    async ({ uuid }) => {
      try {
        const result = await getAgent(client, uuid);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- update_agent ---
  server.tool(
    "update_agent",
    "Update an AI agent's fields via the Yii edit form. Only supplied fields are changed.",
    {
      uuid: z.string().uuid(),
      name: z.string().optional(),
      mainGoal: z.string().optional(),
      prompts: z.string().optional(),
      openingGreeting: z.string().optional(),
      summaryPrompt: z.string().optional(),
      summaryEnabled: z.boolean().optional(),
      debugPrompt: z.string().optional(),
      debugEnabled: z.boolean().optional(),
      phoneNumbers: z.array(z.string()).optional(),
      knowledgeText: z.string().optional(),
      knowledgeWebsites: z.array(z.object({ url: z.string() })).optional(),
      raw: z.record(z.union([z.string(), z.array(z.string())])).optional(),
    },
    async (args) => {
      try {
        // Build AgentUpdate manually to satisfy exactOptionalPropertyTypes:
        // only include properties that are actually present (not undefined).
        const update: import("./tools/agents.js").AgentUpdate = { uuid: args.uuid };
        if (args.name !== undefined) update.name = args.name;
        if (args.mainGoal !== undefined) update.mainGoal = args.mainGoal;
        if (args.prompts !== undefined) update.prompts = args.prompts;
        if (args.openingGreeting !== undefined) update.openingGreeting = args.openingGreeting;
        if (args.summaryPrompt !== undefined) update.summaryPrompt = args.summaryPrompt;
        if (args.summaryEnabled !== undefined) update.summaryEnabled = args.summaryEnabled;
        if (args.debugPrompt !== undefined) update.debugPrompt = args.debugPrompt;
        if (args.debugEnabled !== undefined) update.debugEnabled = args.debugEnabled;
        if (args.phoneNumbers !== undefined) update.phoneNumbers = args.phoneNumbers;
        if (args.knowledgeText !== undefined) update.knowledgeText = args.knowledgeText;
        if (args.knowledgeWebsites !== undefined) update.knowledgeWebsites = args.knowledgeWebsites;
        if (args.raw !== undefined) update.raw = args.raw;
        await updateAgent(client, update);
        return ok({ ok: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- list_custom_fields ---
  server.tool(
    "list_custom_fields",
    "List all Custom Field schema rows for the tenant (the {{ attributes.<slug> }} variable definitions).",
    async () => {
      try {
        const result = await listCustomFields(client);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- upsert_custom_field ---
  server.tool(
    "upsert_custom_field",
    "Create or update a Custom Field by slug (or uuid when present). Returns the saved row with server-assigned uuid.",
    {
      uuid: z.string().nullable().optional(),
      name: z.string(),
      type: z.enum(["string", "integer", "float", "boolean", "date", "array"]),
      slug: z.string(),
      description: z.string(),
    },
    async (args) => {
      try {
        const dto = {
          uuid: args.uuid ?? null,
          name: args.name,
          type: args.type,
          slug: args.slug,
          description: args.description,
        };
        const result = await upsertCustomField(client, dto);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- delete_custom_field ---
  server.tool(
    "delete_custom_field",
    "Delete a Custom Field by slug or uuid. Exactly one must be provided.",
    {
      slug: z.string().optional(),
      uuid: z.string().optional(),
    },
    async (args) => {
      try {
        const key: { slug?: string; uuid?: string } = {};
        if (args.slug !== undefined) key.slug = args.slug;
        if (args.uuid !== undefined) key.uuid = args.uuid;
        await deleteCustomField(client, key);
        return ok({ ok: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- get_contact ---
  server.tool(
    "get_contact",
    "Get a contact's details and Custom Field attribute values by UUID.",
    { uuid: z.string() },
    async ({ uuid }) => {
      try {
        const result = await getContact(client, uuid);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- update_contact_attribute ---
  server.tool(
    "update_contact_attribute",
    "Write a single Custom Field value on a Contact. Validates slug and value before any network call. Use for mid-call state writes.",
    {
      contactUuid: z.string(),
      slug: z.string(),
      value: z.string(),
    },
    async ({ contactUuid, slug, value }) => {
      try {
        await updateContactAttribute(client, { contactUuid, slug, value });
        return ok({ ok: true });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- set_flow_status ---
  server.tool(
    "set_flow_status",
    [
      "Activate or deactivate a flow.",
      "",
      "SAFETY REQUIREMENTS:",
      "• `confirm` must be the flow's EXACT current name (copy it from list_flows). The bridge refuses if it doesn't match, preventing accidental activation of the wrong flow.",
      "• When activating, the bridge runs local validation first — flows with error-severity issues are refused.",
      "• When activating, the bridge checks all other Active flows for inbound phone number collisions. If another Active flow already owns an inbound number this flow also claims, the bridge REFUSES and names both the conflicting flow UUID and the number. Deactivate that flow first if you intend to take over the number.",
      "• The underlying endpoint (`PATCH /v1/flows/<uuid>/activate`) is a TOGGLE — calling it twice returns to the original state. The bridge reads current state and only PATCHes when the desired state differs.",
    ].join("\n"),
    {
      uuid: z.string().min(1, "uuid is required"),
      status: z.enum(["Active", "Inactive"]),
      confirm: z.string().min(1, "confirm is required — must be the flow's exact name"),
    },
    async ({ uuid, status, confirm }) => {
      try {
        const result = await setFlowStatus(client, { uuid, status, confirm });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- list_phone_numbers ---
  server.tool("list_phone_numbers", "List all phone numbers (inbound, outbound, human).", async () => {
    try {
      const result = await listPhoneNumbers(client);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  // --- list_flow_runs ---
  server.tool(
    "list_flow_runs",
    [
      "List recent flow runs (past call records) from the Conversations page.",
      "",
      "Returns an array of FlowRunSummary {uuid, flowUuid, agentUuid, startedAt, durationS, status, channel}.",
      "Optional args: flowUuid (client-side filter), limit (default 25, max 200).",
      "",
      "Note: filtering is best-effort. If the listing page does not embed flow links the bridge cannot filter by flowUuid and returns the full set with a warning. Use get_flow_run to drill into any single record.",
    ].join("\n"),
    {
      flowUuid: z.string().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async (args) => {
      try {
        const callArgs: { flowUuid?: string; limit?: number } = {};
        if (args.flowUuid !== undefined) callArgs.flowUuid = args.flowUuid;
        if (args.limit !== undefined) callArgs.limit = args.limit;
        const result = await listFlowRuns(client, callArgs);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- get_flow_run ---
  server.tool(
    "get_flow_run",
    [
      "Get the full detail for a single flow run (call record) by its UUID.",
      "",
      "Returns FlowRunDetail = FlowRunSummary + {transcript, nodePath?, metadata}.",
      "Use after list_flow_runs to inspect why a specific call took a particular branch, what the transcript looked like, or what metadata the platform recorded.",
    ].join("\n"),
    {
      uuid: z.string().min(1, "uuid is required"),
    },
    async ({ uuid }) => {
      try {
        const result = await getFlowRun(client, uuid);
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --- run_flow_test ---
  server.tool(
    "run_flow_test",
    [
      "Get a test-widget URL the human opens in a browser to run an end-to-end test of a flow.",
      "",
      "Returns {widgetUrl, hint}. The bridge CANNOT drive the chat headlessly — this is honest about the limitation. After the human finishes the test conversation, call list_flow_runs / get_flow_run to inspect the transcript.",
      "",
      "Implementation note: the endpoint is POST /v1/temporary-agent-widget. The bridge tries {flow_uuid} first; on a 400 mentioning agent_uuid it pivots to the flow's first connect_call_agent node's agent_uuid.",
    ].join("\n"),
    {
      flowUuid: z.string().min(1, "flowUuid is required"),
    },
    async ({ flowUuid }) => {
      try {
        const result = await runFlowTest(client, { flowUuid });
        return ok(result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---------- connect + run ----------
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`aiployee-bridge: fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
