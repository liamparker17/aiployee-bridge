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
import { listFlows, getFlow, updateFlow, validateFlowLocal } from "./tools/flows.js";
import { listAgents, getAgent, updateAgent } from "./tools/agents.js";
import { listCustomFields, upsertCustomField, deleteCustomField } from "./tools/custom_fields.js";
import { getContact, updateContactAttribute } from "./tools/contacts.js";
import { listPhoneNumbers } from "./tools/numbers.js";
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

  // Helper: convert Error to MCP text content (isError flag signals failure to caller)
  function fail(err: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
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

  // --- update_flow ---
  server.tool(
    "update_flow",
    "Validate and save a flow DTO. Returns {ok: true} on success.",
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

  // --- list_phone_numbers ---
  server.tool("list_phone_numbers", "List all phone numbers (inbound, outbound, human).", async () => {
    try {
      const result = await listPhoneNumbers(client);
      return ok(result);
    } catch (err) {
      return fail(err);
    }
  });

  // ---------- connect + run ----------
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`aiployee-bridge: fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
