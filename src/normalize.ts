/**
 * normalize.ts — DTO ↔ wire conversion for Flow nodes and connections.
 *
 * `toWire`   : FlowDTO  → SaveFlowRequest  (for POST /v1/nodes/save)
 * `fromWire` : wire meta + FlowNode[]  → FlowDTO  (for GET /v1/flows/{uuid}/nodes)
 */

import { z } from "zod";
import {
  COMPLETED_OUTPUT_INDEX,
  TRANSFER_OUTPUT_INDEX,
  dataKey,
  inputSocketId,
  isTransferBranch,
  outputSocketId,
  type Connection,
  type FlowNode,
  type Socket,
} from "./schema/node.js";
import { type SaveFlowRequest } from "./schema/flow.js";
import {
  RawConfig,
  TRIGGER_TYPES,
  type ConnectionDTO,
  type FlowDTO,
  type NodeDTO,
} from "./dto.js";

type RawConfigKind = z.infer<typeof RawConfig>["kind"];
const RAW_CONFIG_KINDS = new Set<RawConfigKind>(RawConfig.shape.kind.options);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a `fromOutput` value (numeric index or branch label) to a
 * zero-based output socket index.
 *
 * Accepts both the platform's one-r ("Transfered") and the conventional
 * two-r ("Transferred") spellings, plus numeric indices.
 */
function resolveOutputIndex(fromOutput: number | string, type?: FlowNode["type"]): number {
  if (typeof fromOutput === "number") return fromOutput;
  const label = fromOutput.trim().toLowerCase();
  if (label === "completed") return COMPLETED_OUTPUT_INDEX;
  if (isTransferBranch(label)) return TRANSFER_OUTPUT_INDEX;
  // Fallback: try to parse as integer string
  const n = parseInt(label, 10);
  if (!Number.isNaN(n)) return n;
  throw new Error(`unrecognised output label "${fromOutput}" on node type ${type ?? "unknown"}`);
}

/**
 * Given a node type and allocated number, return the number of
 * [inputs, outputs] that should be pre-built before connections are
 * added.
 */
function defaultSocketCounts(
  type: FlowNode["type"],
  isTrigger: boolean,
): [number, number] {
  if (isTrigger) return [0, 1];
  if (type === "connect_call_agent" || type === "call") return [1, 2];
  return [1, 1];
}

/**
 * Determine the branch label for an output-socket index on a given
 * node type. Returns `undefined` when no named label applies (i.e. use
 * the numeric index as `fromOutput`).
 */
function outputLabel(
  type: FlowNode["type"],
  index: number,
): string | undefined {
  if (type === "connect_call_agent" || type === "call") {
    if (index === COMPLETED_OUTPUT_INDEX) return "Completed";
    if (index === TRANSFER_OUTPUT_INDEX) return "Transfered"; // platform spelling
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// toWire
// ---------------------------------------------------------------------------

export function toWire(flow: FlowDTO): SaveFlowRequest {
  // ---- Step 1: allocate sequential numbers and fill in missing UUIDs -----
  type Numbered = { dto: NodeDTO; number: number; uuid: string };
  const numbered: Numbered[] = flow.nodes.map((dto, idx) => ({
    dto,
    number: idx + 1,
    uuid: dto.uuid ?? crypto.randomUUID(),
  }));

  // UUID → allocated number (needed for connection resolution)
  const uuidToNumber = new Map<string, number>(
    numbered.map((n) => [n.uuid, n.number] as const),
  );

  // ---- Step 2: determine needed output-socket counts from connections ----
  // We need at least as many output slots as the highest fromOutput index
  // that any connection references.
  const extraOutputsNeeded = new Map<string, number>();
  for (const conn of flow.connections) {
    const idx = resolveOutputIndex(conn.fromOutput);
    const current = extraOutputsNeeded.get(conn.fromNode) ?? 0;
    if (idx + 1 > current) {
      extraOutputsNeeded.set(conn.fromNode, idx + 1);
    }
  }

  // ---- Step 3: build skeleton sockets (empty connections arrays) ---------
  const outputSockets = new Map<string, Socket[]>();
  const inputSockets = new Map<string, Socket[]>();

  for (const { dto, uuid, number } of numbered) {
    const type = dto.config.kind;
    const isTrigger = TRIGGER_TYPES.has(type);
    const [defaultIn, defaultOut] = defaultSocketCounts(type, isTrigger);

    const neededOut = Math.max(
      defaultOut,
      extraOutputsNeeded.get(uuid) ?? 0,
    );

    const outputs: Socket[] = Array.from({ length: neededOut }, (_, i) => ({
      id: outputSocketId(number, i),
      name: null,
      connections: [],
    }));

    const inputs: Socket[] = Array.from({ length: defaultIn }, (_, i) => ({
      id: inputSocketId(number, i),
      name: null,
      connections: [],
    }));

    outputSockets.set(uuid, outputs);
    inputSockets.set(uuid, inputs);
  }

  // ---- Step 4: populate connections onto both endpoint sockets -----------
  for (const conn of flow.connections) {
    const fromNum = uuidToNumber.get(conn.fromNode);
    const toNum = uuidToNumber.get(conn.toNode);
    if (fromNum === undefined || toNum === undefined) continue;

    const outIdx = resolveOutputIndex(conn.fromOutput);
    const inIdx = conn.toInput;

    const fromOutputs = outputSockets.get(conn.fromNode);
    const toInputs = inputSockets.get(conn.toNode);
    if (!fromOutputs || !toInputs) continue;

    // Ensure target output socket exists (expand if a connection demands it)
    while (fromOutputs.length <= outIdx) {
      fromOutputs.push({
        id: outputSocketId(fromNum, fromOutputs.length),
        name: null,
        connections: [],
      });
    }

    // Ensure target input socket exists
    while (toInputs.length <= inIdx) {
      toInputs.push({
        id: inputSocketId(toNum, toInputs.length),
        name: null,
        connections: [],
      });
    }

    const srcOutSocket = fromOutputs[outIdx];
    const dstInSocket = toInputs[inIdx];
    // These are guaranteed non-undefined because we just ensured they exist.
    if (!srcOutSocket || !dstInSocket) continue;

    const srcOutId = srcOutSocket.id;
    const dstInId = dstInSocket.id;

    // Push connection onto source's output socket (points at target input)
    srcOutSocket.connections.push({
      node_number: toNum,
      node_socket: dstInId,
    });

    // Push connection onto target's input socket (points at source output)
    dstInSocket.connections.push({
      node_number: fromNum,
      node_socket: srcOutId,
    });
  }

  // ---- Step 5: build wire nodes -----------------------------------------
  const wireNodes: FlowNode[] = numbered.map(({ dto, uuid, number }) => {
    const type = dto.config.kind;
    const dk = dataKey(type, number);
    const cfg = dto.config;

    let data: unknown;

    if (cfg.kind === "inbound_call") {
      const gsd = cfg.googleSheetsSync;
      data = {
        data_key: dk,
        phone_numbers: cfg.phoneNumbers,
        cancel_prev_executing: cfg.cancelPrevExecuting,
        google_sheets_sync_data: {
          use_google_sync: gsd?.enabled ?? false,
          google_sheet_id: gsd?.sheetId ?? null,
          google_sheet_name: gsd?.sheetName ?? null,
        },
      };
    } else if (cfg.kind === "connect_call_agent") {
      data = {
        data_key: dk,
        actions: cfg.actions,
        connect_agent_params: {
          copy: cfg.copyAgent,
          type: cfg.agentType,
          uuid: cfg.agentUuid,
          prompt: cfg.prompt,
          phone_numbers: cfg.phoneNumbers,
        },
      };
    } else if (cfg.kind === "call") {
      data = {
        data_key: dk,
        actions: cfg.actions,
        max_concurrent_executing: cfg.maxConcurrentExecuting,
        retry_policy: {
          is_active: cfg.retryPolicy.isActive,
          rules: cfg.retryPolicy.rules,
        },
        agent_params: {
          copy: cfg.copyAgent,
          uuid: cfg.agentUuid,
          prompt: cfg.prompt,
          phone_numbers: cfg.phoneNumbers,
        },
      };
    } else {
      // RawConfig passthrough — refresh data_key (computed key always wins)
      data = { ...cfg.raw, data_key: dk };
    }

    const outputs = outputSockets.get(uuid) ?? [];
    const inputs = inputSockets.get(uuid) ?? [];

    return {
      uuid,
      name: dto.name,
      type,
      status: dto.status,
      number,
      position: [dto.position.x, dto.position.y] as [number, number],
      inputs,
      outputs,
      data,
    };
  });

  return {
    flow_uuid: flow.uuid,
    flow_name: flow.name,
    flow_description: flow.description,
    nodes: wireNodes,
  };
}

// ---------------------------------------------------------------------------
// fromWire
// ---------------------------------------------------------------------------

export function fromWire(
  flowMeta: { uuid: string; name: string; description: string },
  wireNodes: FlowNode[],
): FlowDTO {
  // ---- Build number → uuid map ------------------------------------------
  const numberToUuid = new Map<number, string>(
    wireNodes.map((n) => [n.number, n.uuid] as const),
  );

  // ---- Convert nodes ----------------------------------------------------
  // Per-node tolerance: a single mis-modelled node must not blow up the
  // whole flow. Failures are logged and the node is dropped so the LLM
  // still gets the rest of the graph. validate_flow can flag drift later.
  const nodes: NodeDTO[] = wireNodes.flatMap((wn): NodeDTO[] => {
   try {
    if (wn.data === null || typeof wn.data !== "object" || Array.isArray(wn.data)) {
      throw new Error(`node ${wn.uuid}: data is not an object`);
    }
    const rawData = wn.data as Record<string, unknown>;
    let config: NodeDTO["config"];

    if (wn.type === "inbound_call") {
      const gsd = rawData["google_sheets_sync_data"] as
        | {
            use_google_sync: boolean;
            google_sheet_id: string | null;
            google_sheet_name: string | null;
          }
        | undefined;

      const phoneNumbers = Array.isArray(rawData["phone_numbers"])
        ? (rawData["phone_numbers"] as string[])
        : [];
      const cancelPrevExecuting =
        typeof rawData["cancel_prev_executing"] === "boolean"
          ? rawData["cancel_prev_executing"]
          : false;

      config = {
        kind: "inbound_call",
        phoneNumbers,
        cancelPrevExecuting,
        ...(gsd !== undefined
          ? {
              googleSheetsSync: {
                enabled: gsd.use_google_sync,
                sheetId: gsd.google_sheet_id,
                sheetName: gsd.google_sheet_name,
              },
            }
          : {}),
      };
    } else if (wn.type === "connect_call_agent") {
      const params = rawData["connect_agent_params"] as
        | {
            copy: boolean;
            type: "ai" | "real";
            uuid: string;
            prompt: string | null;
            phone_numbers: string[];
          }
        | undefined;

      if (params === undefined) {
        throw new Error(`node ${wn.uuid}: connect_call_agent missing connect_agent_params`);
      }

      config = {
        kind: "connect_call_agent",
        agentUuid: params.uuid,
        agentType: params.type,
        copyAgent: params.copy,
        prompt: params.prompt,
        phoneNumbers: Array.isArray(params.phone_numbers)
          ? params.phone_numbers
          : [],
        actions: Array.isArray(rawData["actions"])
          ? (rawData["actions"] as unknown[])
          : [],
      };
    } else if (wn.type === "call") {
      const params = rawData["agent_params"] as
        | {
            copy: boolean;
            uuid: string;
            prompt: string | null;
            phone_numbers: string[];
          }
        | undefined;

      if (params === undefined) {
        throw new Error(`node ${wn.uuid}: call missing agent_params`);
      }
      const retryPolicy = rawData["retry_policy"] as
        | { is_active: boolean; rules: unknown[] }
        | undefined;

      config = {
        kind: "call",
        agentUuid: params.uuid,
        copyAgent: params.copy,
        prompt: params.prompt,
        phoneNumbers: Array.isArray(params.phone_numbers)
          ? params.phone_numbers
          : [],
        actions: Array.isArray(rawData["actions"])
          ? (rawData["actions"] as unknown[])
          : [],
        maxConcurrentExecuting:
          typeof rawData["max_concurrent_executing"] === "number"
            ? rawData["max_concurrent_executing"]
            : null,
        retryPolicy: {
          isActive: retryPolicy?.is_active ?? false,
          rules: retryPolicy?.rules ?? [],
        },
      };
    } else {
      // RawConfig passthrough — strip data_key, keep the rest
      if (!RAW_CONFIG_KINDS.has(wn.type as RawConfigKind)) {
        throw new Error(`node ${wn.uuid}: unsupported type ${wn.type}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { data_key: _dk, ...rest } = rawData;
      config = {
        kind: wn.type as RawConfigKind,
        raw: rest,
      };
    }

    return [{
      uuid: wn.uuid,
      name: wn.name,
      position: { x: wn.position[0], y: wn.position[1] },
      status: wn.status,
      config,
    }];
   } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[aiployee-bridge] dropping node ${wn.uuid} (${wn.type}) during fromWire: ${reason.slice(0, 200)}`,
      );
      return [];
   }
  });

  // ---- Convert connections (iterate output sockets only) ----------------
  const connections: ConnectionDTO[] = [];

  for (const wn of wireNodes) {
    for (let outIdx = 0; outIdx < wn.outputs.length; outIdx++) {
      const outSocket = wn.outputs[outIdx];
      if (!outSocket) continue;

      for (const conn of outSocket.connections) {
        const targetUuid = numberToUuid.get(conn.node_number);
        if (targetUuid === undefined) continue; // dangling edge — silently drop

        // Determine fromOutput: named label or numeric index
        const label = outputLabel(wn.type, outIdx);
        const fromOutput: number | string = label !== undefined ? label : outIdx;

        // Parse toInput from the trailing _<n> of node_socket (e.g. "ID_21_0" → 0)
        const lastUnderscore = conn.node_socket.lastIndexOf("_");
        const toInput =
          lastUnderscore >= 0
            ? parseInt(conn.node_socket.slice(lastUnderscore + 1), 10)
            : 0;

        connections.push({
          fromNode: wn.uuid,
          fromOutput,
          toNode: targetUuid,
          toInput: Number.isNaN(toInput) ? 0 : toInput,
        });
      }
    }
  }

  return {
    uuid: flowMeta.uuid,
    name: flowMeta.name,
    description: flowMeta.description,
    nodes,
    connections,
  };
}
