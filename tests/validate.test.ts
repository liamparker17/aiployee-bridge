import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { validateFlow, normalizeZaPhoneNumber } from "../src/validate.js";
import type { FlowDTO } from "../src/dto.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const TRIGGER_UUID  = "aaaaaaaa-0000-4000-8000-000000000001";
const CONNECT_UUID  = "aaaaaaaa-0000-4000-8000-000000000002";
const AGENT_UUID    = "bbbbbbbb-0000-4000-8000-000000000001";
const UNKNOWN_UUID  = "dddddddd-0000-4000-8000-000000000099";

function makeTriggerNode(uuid = TRIGGER_UUID): FlowDTO["nodes"][0] {
  return {
    uuid,
    name: "Inbound",
    position: { x: 0, y: 0 },
    status: 1,
    config: {
      kind: "inbound_call",
      phoneNumbers: ["+27877295318"],
      cancelPrevExecuting: false,
    },
  };
}

function makeConnectNode(uuid = CONNECT_UUID): FlowDTO["nodes"][0] {
  return {
    uuid,
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
  };
}

function emptyFlow(): FlowDTO {
  return {
    uuid: "cccccccc-0000-4000-8000-000000000001",
    name: "Empty",
    description: "",
    nodes: [],
    connections: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateFlow", () => {
  it("empty flow → exactly one issue: no trigger node", () => {
    const issues = validateFlow(emptyFlow());
    assert.equal(issues.length, 1);
    assert.ok(issues[0]!.message.includes("no trigger node"));
    assert.equal(issues[0]!.node_id, null);
    assert.equal(issues[0]!.severity, "error");
  });

  it("two trigger nodes → exactly one issue on the second trigger", () => {
    const SECOND_UUID = "aaaaaaaa-0000-4000-8000-000000000005";
    const flow: FlowDTO = {
      ...emptyFlow(),
      nodes: [
        makeTriggerNode(TRIGGER_UUID),
        makeTriggerNode(SECOND_UUID),
      ],
    };
    const issues = validateFlow(flow);
    // Should have exactly one issue total (the duplicate trigger)
    assert.equal(issues.length, 1);
    const triggerIssues = issues.filter((i) => i.node_id === SECOND_UUID);
    assert.equal(triggerIssues.length, 1);
    assert.equal(triggerIssues[0]!.severity, "error");
  });

  it("Inbound Call with empty phoneNumbers → one issue with that node uuid", () => {
    const flow: FlowDTO = {
      ...emptyFlow(),
      nodes: [
        {
          uuid: TRIGGER_UUID,
          name: "Inbound",
          position: { x: 0, y: 0 },
          status: 1,
          config: {
            kind: "inbound_call",
            phoneNumbers: [],
            cancelPrevExecuting: false,
          },
        },
      ],
    };
    const issues = validateFlow(flow);
    const phoneIssue = issues.find((i) => i.node_id === TRIGGER_UUID);
    assert.ok(phoneIssue, "expected an issue referencing the trigger uuid");
    assert.equal(phoneIssue.severity, "error");
  });

  it("connect_call_agent with empty agentUuid → one issue with that node uuid", () => {
    const flow: FlowDTO = {
      ...emptyFlow(),
      nodes: [
        makeTriggerNode(),
        {
          uuid: CONNECT_UUID,
          name: "Connect",
          position: { x: 200, y: 0 },
          status: 1,
          config: {
            kind: "connect_call_agent",
            agentUuid: "" as unknown as `${string}-${string}-${string}-${string}-${string}`,
            agentType: "ai",
            copyAgent: false,
            prompt: null,
            phoneNumbers: [],
            actions: [],
          },
        },
      ],
    };
    const issues = validateFlow(flow);
    const agentIssue = issues.find((i) => i.node_id === CONNECT_UUID);
    assert.ok(agentIssue, "expected an issue referencing connect node uuid");
    assert.equal(agentIssue.severity, "error");
  });

  it("connection referencing unknown toNode uuid → one issue", () => {
    const flow: FlowDTO = {
      ...emptyFlow(),
      nodes: [makeTriggerNode()],
      connections: [
        { fromNode: TRIGGER_UUID, fromOutput: 0, toNode: UNKNOWN_UUID, toInput: 0 },
      ],
    };
    const issues = validateFlow(flow);
    const connIssue = issues.find((i) => i.node_id === UNKNOWN_UUID);
    assert.ok(connIssue, "expected a connection issue referencing the unknown uuid");
    assert.equal(connIssue.severity, "error");
  });

  it("valid 2-node flow → no issues", () => {
    const flow: FlowDTO = {
      ...emptyFlow(),
      nodes: [makeTriggerNode(), makeConnectNode()],
      connections: [
        { fromNode: TRIGGER_UUID, fromOutput: 0, toNode: CONNECT_UUID, toInput: 0 },
      ],
    };
    const issues = validateFlow(flow);
    assert.equal(issues.length, 0);
  });
});

describe("normalizeZaPhoneNumber", () => {
  it('leading-zero format → E.164: "0877295318" → "+27877295318"', () => {
    assert.equal(normalizeZaPhoneNumber("0877295318"), "+27877295318");
  });

  it('already E.164 → unchanged: "+27877295318"', () => {
    assert.equal(normalizeZaPhoneNumber("+27877295318"), "+27877295318");
  });

  it('non-numeric string → returned as-is: "abc"', () => {
    assert.equal(normalizeZaPhoneNumber("abc"), "abc");
  });
});
