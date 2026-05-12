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
import { listAgents } from "./tools/agents.js";
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
