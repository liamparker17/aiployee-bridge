/**
 * flow_status.test.ts — unit tests for setFlowStatus.
 *
 * All tests use injected fetchImpl. No real network calls.
 *
 * The mock fetchImpl handles URL patterns in the order each test needs:
 *   GET  /v1/flows                   → FlowSummary list (JSON envelope)
 *   GET  /v1/flows/<uuid>/nodes      → FlowNode list (via getFlowNodes inside getFlow)
 *   PATCH /v1/flows/<uuid>/activate  → toggle response (JSON envelope)
 *   (second GET /v1/flows)           → re-fetch for status verification
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Transport } from "../src/client/transport.js";
import { setFlowStatus } from "../src/client/flow_status.js";
import type { Client } from "../src/client/index.js";

// ---------------------------------------------------------------------------
// UUIDs used across tests
// ---------------------------------------------------------------------------
const FLOW_UUID = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_UUID = "bbbbbbbb-0000-0000-0000-000000000002";
const PHONE = "+27877295318";

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function envelope(result: unknown): string {
  return JSON.stringify({ success: true, code: 200, result, errors: null });
}

function fakeResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

// ---------------------------------------------------------------------------
// Wire-shape helpers
// ---------------------------------------------------------------------------

/**
 * Minimal /v1/flows JSON list item.
 */
function flowListItem(
  uuid: string,
  name: string,
  status: "Active" | "Inactive",
): Record<string, unknown> {
  return { uuid, name, status, updated_at: "2026-05-12T10:00:00Z" };
}

/**
 * Minimal /v1/flows/<uuid>/nodes item — returns a single inbound_call node.
 */
function inboundCallNode(phoneNumbers: string[]): Record<string, unknown> {
  return {
    uuid: "cccccccc-0000-0000-0000-000000000003",
    name: "Inbound Call",
    number: 1,
    status: 1,
    type: "inbound_call",
    position: { x: 0, y: 0 },
    data: {
      phone_numbers: phoneNumbers,
      cancel_prev_executing: false,
    },
    outputs: [],
    inputs: [],
    connections: [],
  };
}

/**
 * Node list for a flow with no trigger (validation-failing).
 */
function noTriggerNode(): Record<string, unknown> {
  return {
    uuid: "dddddddd-0000-0000-0000-000000000004",
    name: "Some Node",
    number: 1,
    status: 1,
    type: "filter",
    position: { x: 0, y: 0 },
    data: {},
    outputs: [],
    inputs: [],
    connections: [],
  };
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal duck-typed Client driven by a custom fetchImpl.
 * The transport points at a fake API base; all responses come from fetchImpl.
 */
function makeClient(fetchImpl: typeof fetch): Client {
  const transport = new Transport({
    apiBase: "https://api.example.com",
    token: "test-token",
    fetchImpl,
  });

  // Minimal Client duck-type — only what setFlowStatus uses:
  //   c.transport.request(...)  → listFlows, PATCH, re-fetch
  //   c.getFlowNodes(uuid)      → inside getFlow (called from setFlowStatus)
  const c = {
    transport,
    getFlowNodes(uuid: string) {
      // Proxy through transport.request — getFlow calls c.getFlowNodes
      return transport.request<unknown[]>({ method: "GET", path: `/flows/${uuid}/nodes` });
    },
  } as unknown as Client;

  return c;
}

// ---------------------------------------------------------------------------
// Test 1: Confirm-token mismatch
// ---------------------------------------------------------------------------

describe("setFlowStatus — confirm-token mismatch", () => {
  it("throws with expected/got values and never PATCHes", async () => {
    let patchCalled = false;
    let getFlowNodesCalled = false;
    let callCount = 0;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      callCount++;
      if (url.includes("/activate")) {
        patchCalled = true;
        return fakeResponse(envelope({ flipped: true }));
      }
      if (url.includes("/nodes")) {
        getFlowNodesCalled = true;
        return fakeResponse(envelope([]));
      }
      // listFlows — must come last (no /activate, no /nodes)
      return fakeResponse(
        envelope([flowListItem(FLOW_UUID, "My Flow", "Inactive")]),
      );
    };

    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        setFlowStatus(c, {
          uuid: FLOW_UUID,
          status: "Active",
          confirm: "Wrong Name",
        }),
      (err: Error) => {
        assert.ok(err.message.includes("My Flow"), "message should include expected name");
        assert.ok(err.message.includes("Wrong Name"), "message should include got value");
        assert.ok(err.message.includes("confirm token"), "message should mention confirm token");
        return true;
      },
    );

    assert.equal(patchCalled, false, "PATCH must not be called on confirm mismatch");
    assert.equal(getFlowNodesCalled, false, "getFlow must not be called on confirm mismatch");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Status already matches (no-op)
// ---------------------------------------------------------------------------

describe("setFlowStatus — status already matches", () => {
  it("returns {changed: false} without calling getFlow or PATCH", async () => {
    let patchCalled = false;
    let getFlowCalled = false;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/nodes")) {
        getFlowCalled = true;
        return fakeResponse(envelope([]));
      }
      if (url.includes("/activate")) {
        patchCalled = true;
        return fakeResponse(envelope({ flipped: true }));
      }
      // listFlows — flow is already Inactive
      return fakeResponse(
        envelope([flowListItem(FLOW_UUID, "My Flow", "Inactive")]),
      );
    };

    const c = makeClient(fetchImpl);
    const result = await setFlowStatus(c, {
      uuid: FLOW_UUID,
      status: "Inactive",
      confirm: "My Flow",
    });

    assert.equal(result.changed, false);
    assert.equal(result.previousStatus, "Inactive");
    assert.equal(result.newStatus, "Inactive");
    assert.deepEqual(result.phoneNumbersAffected, []);
    assert.equal(patchCalled, false, "PATCH must not fire on no-op");
    assert.equal(getFlowCalled, false, "getFlow must not be called on no-op");
  });
});

// ---------------------------------------------------------------------------
// Test 3: Inactive → Active — validation-failing flow
// ---------------------------------------------------------------------------

describe("setFlowStatus — Inactive→Active with validation error", () => {
  it("throws on error-severity validation issue, never PATCHes", async () => {
    let patchCalled = false;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/nodes")) {
        // Return a flow with no trigger node → validation error
        return fakeResponse(envelope([noTriggerNode()]));
      }
      if (url.includes("/activate")) {
        patchCalled = true;
        return fakeResponse(envelope({ flipped: true }));
      }
      // listFlows
      return fakeResponse(
        envelope([flowListItem(FLOW_UUID, "My Flow", "Inactive")]),
      );
    };

    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        setFlowStatus(c, {
          uuid: FLOW_UUID,
          status: "Active",
          confirm: "My Flow",
        }),
      (err: Error) => {
        assert.ok(err.message.includes("validation errors"), "message mentions validation errors");
        return true;
      },
    );

    assert.equal(patchCalled, false, "PATCH must not fire on validation failure");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Inactive → Active — phone collision
// ---------------------------------------------------------------------------

describe("setFlowStatus — Inactive→Active with phone collision", () => {
  it("throws naming both UUIDs and the conflicting number, never PATCHes", async () => {
    let patchCalled = false;

    // Sequence of responses per URL:
    //   1. GET /v1/flows                     → [FLOW_UUID Inactive, OTHER_UUID Active]
    //   2. GET /v1/flows/FLOW_UUID/nodes     → [inbound_call with PHONE]
    //   3. GET /v1/flows/OTHER_UUID/nodes    → [inbound_call with same PHONE]
    //   (no PATCH)

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/activate")) {
        patchCalled = true;
        return fakeResponse(envelope({ flipped: true }));
      }
      if (url.includes(`/flows/${FLOW_UUID}/nodes`)) {
        return fakeResponse(envelope([inboundCallNode([PHONE])]));
      }
      if (url.includes(`/flows/${OTHER_UUID}/nodes`)) {
        return fakeResponse(envelope([inboundCallNode([PHONE])]));
      }
      // listFlows — this flow Inactive, other Active
      return fakeResponse(
        envelope([
          flowListItem(FLOW_UUID, "My Flow", "Inactive"),
          flowListItem(OTHER_UUID, "Other Flow", "Active"),
        ]),
      );
    };

    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        setFlowStatus(c, {
          uuid: FLOW_UUID,
          status: "Active",
          confirm: "My Flow",
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes(FLOW_UUID),
          `message must include THIS flow UUID; got: ${err.message}`,
        );
        assert.ok(
          err.message.includes(OTHER_UUID),
          `message must include other flow UUID; got: ${err.message}`,
        );
        assert.ok(
          err.message.includes(PHONE),
          `message must include the conflicting number; got: ${err.message}`,
        );
        assert.ok(
          err.message.includes("collision"),
          `message must say collision; got: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(patchCalled, false, "PATCH must not fire on collision");
  });
});

// ---------------------------------------------------------------------------
// Test 5: Inactive → Active happy path
// ---------------------------------------------------------------------------

describe("setFlowStatus — Inactive→Active happy path", () => {
  it("PATCHes once, verifies re-fetch, returns changed:true + phoneNumbersAffected", async () => {
    let patchCount = 0;
    let patchBody: unknown = null;
    let patchUrl: string = "";
    // Call sequence for /v1/flows: first call returns Inactive, second (verify) returns Active
    let listCallCount = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(`/flows/${FLOW_UUID}/nodes`)) {
        return fakeResponse(envelope([inboundCallNode([PHONE])]));
      }
      if (url.includes("/activate")) {
        patchCount++;
        patchUrl = url;
        patchBody = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
        return fakeResponse(envelope({ flipped: true }));
      }
      // listFlows — first call: Inactive; second call (verify): Active
      listCallCount++;
      const status = listCallCount === 1 ? "Inactive" : "Active";
      return fakeResponse(
        envelope([flowListItem(FLOW_UUID, "My Flow", status as "Active" | "Inactive")]),
      );
    };

    const c = makeClient(fetchImpl);
    const result = await setFlowStatus(c, {
      uuid: FLOW_UUID,
      status: "Active",
      confirm: "My Flow",
    });

    assert.equal(result.changed, true);
    assert.equal(result.previousStatus, "Inactive");
    assert.equal(result.newStatus, "Active");
    assert.deepEqual(result.phoneNumbersAffected, [PHONE]);
    assert.equal(patchCount, 1, "PATCH must fire exactly once");
    assert.ok(patchUrl.includes(`/flows/${FLOW_UUID}/activate`), "PATCH URL is correct");
    assert.deepEqual(patchBody, {}, "PATCH body must be empty object");
  });
});

// ---------------------------------------------------------------------------
// Test 6: Active → Inactive happy path
// ---------------------------------------------------------------------------

describe("setFlowStatus — Active→Inactive happy path", () => {
  it("PATCHes once, returns changed:true, no collision check needed", async () => {
    let patchCount = 0;
    let listCallCount = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes(`/flows/${FLOW_UUID}/nodes`)) {
        // Called for deactivation to collect phone numbers for return value
        return fakeResponse(envelope([inboundCallNode([PHONE])]));
      }
      if (url.includes("/activate")) {
        patchCount++;
        return fakeResponse(envelope({ flipped: true }));
      }
      // listFlows — first call: Active; second call (verify): Inactive
      listCallCount++;
      const status = listCallCount === 1 ? "Active" : "Inactive";
      return fakeResponse(
        envelope([flowListItem(FLOW_UUID, "My Flow", status as "Active" | "Inactive")]),
      );
    };

    const c = makeClient(fetchImpl);
    const result = await setFlowStatus(c, {
      uuid: FLOW_UUID,
      status: "Inactive",
      confirm: "My Flow",
    });

    assert.equal(result.changed, true);
    assert.equal(result.previousStatus, "Active");
    assert.equal(result.newStatus, "Inactive");
    assert.deepEqual(result.phoneNumbersAffected, [PHONE]);
    assert.equal(patchCount, 1, "PATCH must fire exactly once");
  });
});

// ---------------------------------------------------------------------------
// Test 7: PATCH succeeded but re-fetch shows wrong status
// ---------------------------------------------------------------------------

describe("setFlowStatus — PATCH succeeded but re-fetch shows wrong status", () => {
  it("throws describing the discrepancy", async () => {
    let listCallCount = 0;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes(`/flows/${FLOW_UUID}/nodes`)) {
        return fakeResponse(envelope([inboundCallNode([PHONE])]));
      }
      if (url.includes("/activate")) {
        return fakeResponse(envelope({ flipped: true }));
      }
      // listFlows — BOTH calls return Inactive (verify call sees same status)
      listCallCount++;
      return fakeResponse(
        envelope([flowListItem(FLOW_UUID, "My Flow", "Inactive")]),
      );
    };

    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        setFlowStatus(c, {
          uuid: FLOW_UUID,
          status: "Active",
          confirm: "My Flow",
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("toggle PATCH succeeded"),
          `message should mention toggle PATCH; got: ${err.message}`,
        );
        return true;
      },
    );
  });
});
