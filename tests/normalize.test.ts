import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { toWire, fromWire } from "../src/normalize.js";
import type { FlowDTO } from "../src/dto.js";

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

const TRIGGER_UUID = "aaaaaaaa-0000-4000-8000-000000000001";
const CONNECT_UUID = "aaaaaaaa-0000-4000-8000-000000000002";
const CALL_UUID    = "aaaaaaaa-0000-4000-8000-000000000003";
const AGENT_UUID   = "bbbbbbbb-0000-4000-8000-000000000001";

function makeFlow(overrides?: Partial<FlowDTO>): FlowDTO {
  const base: FlowDTO = {
    uuid: "cccccccc-0000-4000-8000-000000000001",
    name: "Test Flow",
    description: "desc",
    nodes: [
      {
        uuid: TRIGGER_UUID,
        name: "Inbound",
        position: { x: 0, y: 0 },
        status: 1,
        config: {
          kind: "inbound_call",
          phoneNumbers: ["+27877295318"],
          cancelPrevExecuting: false,
        },
      },
      {
        uuid: CONNECT_UUID,
        name: "Connect",
        position: { x: 200, y: 0 },
        status: 1,
        config: {
          kind: "connect_call_agent",
          agentUuid: AGENT_UUID,
          agentType: "ai",
          copyAgent: false,
          prompt: null,
          phoneNumbers: [],
          actions: [],
        },
      },
      {
        uuid: CALL_UUID,
        name: "Call",
        position: { x: 400, y: 0 },
        status: 1,
        config: {
          kind: "call",
          agentUuid: AGENT_UUID,
          copyAgent: false,
          prompt: null,
          phoneNumbers: [],
          actions: [],
          maxConcurrentExecuting: null,
          retryPolicy: { isActive: false, rules: [] },
        },
      },
    ],
    connections: [
      // trigger → connect (output 0 = Completed)
      { fromNode: TRIGGER_UUID, fromOutput: 0, toNode: CONNECT_UUID, toInput: 0 },
      // connect Transfer branch → call
      { fromNode: CONNECT_UUID, fromOutput: "Transfered", toNode: CALL_UUID, toInput: 0 },
    ],
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("toWire", () => {
  it("happy path: numbers 1,2,3; socket ids; data_key; both-socket connection mirroring", () => {
    const req = makeFlow();
    const wire = toWire(req);

    assert.equal(wire.nodes.length, 3);

    // Anchor lookups by uuid so the test is order-independent
    const byUuid = new Map(req.nodes.map((n) => [n.uuid, n] as const));
    assert.ok(byUuid.has(TRIGGER_UUID), "fixture must contain TRIGGER_UUID");
    assert.ok(byUuid.has(CONNECT_UUID), "fixture must contain CONNECT_UUID");
    assert.ok(byUuid.has(CALL_UUID),    "fixture must contain CALL_UUID");

    const n1 = wire.nodes.find((n) => n.uuid === TRIGGER_UUID)!;
    const n2 = wire.nodes.find((n) => n.uuid === CONNECT_UUID)!;
    const n3 = wire.nodes.find((n) => n.uuid === CALL_UUID)!;

    assert.equal(n1.number, 1);
    assert.equal(n2.number, 2);
    assert.equal(n3.number, 3);

    // Socket id pattern check
    assert.match(n1.outputs[0]!.id, /^OD_1_0$/);
    assert.match(n2.inputs[0]!.id, /^ID_2_0$/);
    assert.match(n2.outputs[0]!.id, /^OD_2_0$/);
    assert.match(n2.outputs[1]!.id, /^OD_2_1$/);

    // data_key for every node
    assert.equal((n1.data as { data_key: string }).data_key, "inbound_call_node_1");
    assert.equal((n2.data as { data_key: string }).data_key, "connect_call_agent_node_2");
    assert.equal((n3.data as { data_key: string }).data_key, "call_node_3");

    // The Transfered connection (connect→call, output index 1) must appear
    // on connect's output socket AND call's input socket.
    const connectTransferSocket = n2.outputs[1]!;
    assert.equal(connectTransferSocket.connections.length, 1);
    const fwdConn = connectTransferSocket.connections[0]!;
    assert.equal(fwdConn.node_number, n3.number); // call's assigned number
    // fwdConn.node_socket must equal call's input-0 id literally
    assert.equal(fwdConn.node_socket, `ID_${n3.number}_0`);

    // Mirror on call's input socket
    const callInputSocket = n3.inputs[0]!;
    const mirrorConn = callInputSocket.connections.find((c) => c.node_number === n2.number);
    assert.ok(mirrorConn, "mirror connection not found on call's input socket");
    assert.equal(mirrorConn.node_socket, `OD_${n2.number}_1`);
  });

  it("uuid: null on a new node → uuid is assigned and surfaces in output", () => {
    const flow = makeFlow();
    flow.nodes[0] = { ...flow.nodes[0]!, uuid: null };

    const wire = toWire(flow);
    const firstNode = wire.nodes[0]!;
    assert.ok(firstNode.uuid, "uuid should be a non-empty string");
    // Basic UUID v4-ish pattern check
    assert.match(firstNode.uuid, /^[0-9a-f-]{36}$/);
  });

  it("RawConfig passthrough: data block contains data_key plus raw fields", () => {
    const flow: FlowDTO = {
      uuid: "cccccccc-0000-4000-8000-000000000001",
      name: "Raw Test",
      description: "",
      nodes: [
        {
          uuid: TRIGGER_UUID,
          name: "Split",
          position: { x: 0, y: 0 },
          status: 1,
          config: {
            kind: "split",
            raw: { foo: "bar", baz: 42 },
          },
        },
      ],
      connections: [],
    };

    const wire = toWire(flow);
    const node = wire.nodes[0]!;
    const data = node.data as Record<string, unknown>;
    assert.equal(data["data_key"], "split_node_1");
    assert.equal(data["foo"], "bar");
    assert.equal(data["baz"], 42);
  });
});

describe("fromWire → toWire round-trip", () => {
  it("nodes by uuid and connections as a set match the original DTO", () => {
    const original = makeFlow();
    const wire = toWire(original);
    const meta = { uuid: original.uuid, name: original.name, description: original.description };
    const restored = fromWire(meta, wire.nodes);

    // Nodes: check by uuid that position+config.kind survive
    const originalByUuid = new Map(original.nodes.map((n) => [n.uuid!, n]));
    for (const rNode of restored.nodes) {
      const orig = originalByUuid.get(rNode.uuid!);
      assert.ok(orig, `unexpected uuid ${rNode.uuid}`);
      assert.equal(rNode.config.kind, orig.config.kind);
      assert.equal(rNode.position.x, orig.position.x);
      assert.equal(rNode.position.y, orig.position.y);
    }

    // Connections: normalise fromOutput to string for comparison
    type ConnTuple = { fromNode: string; fromOutput: string | number; toNode: string; toInput: number };
    const normalize = (c: ConnTuple) =>
      `${c.fromNode}→${String(c.fromOutput)}→${c.toNode}:${c.toInput}`;

    const origSet = new Set(original.connections.map(normalize));
    const restoredSet = new Set(restored.connections.map(normalize));

    // The original has "Transfered"; fromWire emits "Transfered" for index 1
    // so both sides use the platform's one-r spelling.
    assert.deepEqual(restoredSet, origSet);
  });

  it("dangling target node_number → connection is dropped, others survive", () => {
    // Build a wire manually: node 1 (inbound_call) with an output socket that
    // references node_number 99 (does not exist), plus a valid connection to node 2.
    const nodeA = toWire(makeFlow()).nodes[0]!;
    const nodeB = toWire(makeFlow()).nodes[1]!;

    // Inject a dangling reference into nodeA's output socket 0
    const patchedNodeA = {
      ...nodeA,
      outputs: [
        {
          ...nodeA.outputs[0]!,
          connections: [
            { node_number: 99, node_socket: "ID_99_0" }, // dangling
            { node_number: nodeB.number, node_socket: nodeB.inputs[0]!.id }, // valid
          ],
        },
      ],
    };

    const meta = { uuid: "cccccccc-0000-4000-8000-000000000001", name: "T", description: "" };
    const dto = fromWire(meta, [patchedNodeA, nodeB]);

    // Exactly one edge survives: the dangling one is silently omitted
    assert.equal(dto.connections.length, 1, "dangling connection must be dropped; only one edge should survive");

    // The surviving edge must link the two real nodes
    const surviving = dto.connections[0]!;
    assert.equal(surviving.fromNode, nodeA.uuid, "surviving edge fromNode must be nodeA's uuid");
    assert.equal(surviving.toNode,   nodeB.uuid,  "surviving edge toNode must be nodeB's uuid");
  });

  it('branch-label round-trip: fromOutput "Transferred" (two-r) → wire index 1 → "Transfered" (one-r) on restore', () => {
    // Use the two-r spelling in the input DTO
    const flow = makeFlow({
      connections: [
        { fromNode: TRIGGER_UUID, fromOutput: 0, toNode: CONNECT_UUID, toInput: 0 },
        { fromNode: CONNECT_UUID, fromOutput: "Transferred", toNode: CALL_UUID, toInput: 0 },
      ],
    });

    const wire = toWire(flow);

    // Wire index 1 on connect's outputs should carry the connection
    const connectNode = wire.nodes[1]!;
    assert.equal(connectNode.outputs[1]!.connections.length, 1, "output index 1 should have the transfer connection");

    // Restore
    const meta = { uuid: flow.uuid, name: flow.name, description: flow.description };
    const restored = fromWire(meta, wire.nodes);

    const transferConn = restored.connections.find(
      (c) => c.fromNode === CONNECT_UUID && c.toNode === CALL_UUID,
    );
    assert.ok(transferConn, "transfer connection should be present after round-trip");
    // fromWire emits the platform's one-r spelling for index 1
    assert.equal(
      transferConn.fromOutput,
      "Transfered",
      'platform one-r spelling "Transfered" expected on restore',
    );
  });
});
