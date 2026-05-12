/**
 * test_widget.ts — POST /v1/temporary-agent-widget to obtain a test widget URL.
 *
 * The bridge cannot drive the interactive chat headlessly. It returns a
 * widgetUrl the user opens manually in a browser. After the test conversation
 * is complete, get_flow_run reads the transcript.
 */

import type { Client } from "./index.js";
import { ApiError } from "../schema/envelope.js";
import { getFlow } from "../tools/flows.js";

export interface RunFlowTestArgs {
  flowUuid: string;
}

export interface RunFlowTestResult {
  widgetUrl: string;
  /** A short message the bridge surfaces to the LLM caller alongside the URL. */
  hint: string;
}

const HINT =
  "Open this URL in your browser to start a test conversation with the flow. After you finish, call get_flow_run to read the transcript.";

/**
 * Probe the response result for a widget URL, checking the most common
 * field names in order of likelihood.
 *
 * Throws if none match.
 */
function extractWidgetUrl(result: unknown): string {
  if (typeof result === "string" && result.length > 0) {
    return result;
  }
  if (typeof result === "object" && result !== null) {
    const r = result as Record<string, unknown>;
    for (const key of ["widget_url", "url", "widgetUrl"] as const) {
      const v = r[key];
      if (typeof v === "string" && v.length > 0) {
        return v;
      }
    }
  }
  const preview = JSON.stringify(result).slice(0, 200);
  throw new Error(
    `could not find widget URL in /v1/temporary-agent-widget response: ${preview}`,
  );
}

/**
 * Return a test widget URL for the given flow.
 *
 * First attempt: POST with `{flow_uuid}`.
 * Pivot (only on 400 + "agent_uuid" in the error message):
 *   find the flow's first connect_call_agent node, read its agentUuid,
 *   retry with `{agent_uuid}`.
 */
export async function runFlowTest(
  c: Client,
  args: RunFlowTestArgs,
): Promise<RunFlowTestResult> {
  // --- Local validation ---
  if (!args.flowUuid || args.flowUuid.trim().length === 0) {
    throw new Error("flowUuid must be a non-empty string");
  }
  if (/[\r\n]/.test(args.flowUuid)) {
    throw new Error(
      "flowUuid contains illegal characters (CR/LF); check the input",
    );
  }

  // --- First try: {flow_uuid} ---
  let result: unknown;
  try {
    result = await c.transport.request<unknown>({
      method: "POST",
      path: "/temporary-agent-widget",
      body: { flow_uuid: args.flowUuid },
    });
  } catch (err) {
    // Pivot only when the error is a 400 that mentions agent_uuid.
    if (
      err instanceof ApiError &&
      (err.httpStatus === 400 || err.code === 400) &&
      /agent_uuid/i.test(err.message)
    ) {
      // --- Pivot path: resolve agent_uuid from the flow ---
      const flow = await getFlow(c, args.flowUuid);
      const agentNode = flow.nodes.find(
        (n) => n.config.kind === "connect_call_agent",
      );
      if (agentNode === undefined) {
        throw new Error(
          "flow has no connect_call_agent node; cannot resolve agent_uuid for /v1/temporary-agent-widget pivot",
        );
      }
      // config is narrowed to ConnectCallAgentConfig here
      const cfg = agentNode.config;
      if (cfg.kind !== "connect_call_agent") {
        throw new Error(
          "flow has no connect_call_agent node; cannot resolve agent_uuid for /v1/temporary-agent-widget pivot",
        );
      }
      const agentUuid = cfg.agentUuid;

      // Second try: {agent_uuid}
      result = await c.transport.request<unknown>({
        method: "POST",
        path: "/temporary-agent-widget",
        body: { agent_uuid: agentUuid },
      });
    } else {
      throw err;
    }
  }

  const widgetUrl = extractWidgetUrl(result);
  return { widgetUrl, hint: HINT };
}
