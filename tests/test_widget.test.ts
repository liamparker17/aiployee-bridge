/**
 * test_widget.test.ts — unit tests for runFlowTest.
 *
 * All tests use injected fetchImpl. No real network calls.
 *
 * URL patterns handled by mocks:
 *   POST /v1/temporary-agent-widget  → first-try or pivot second-try
 *   GET  /v1/flows/<uuid>/nodes      → used in pivot path (via getFlow → c.getFlowNodes)
 *   GET  /v1/flows                   → used in pivot path (via getFlow → listFlows for name)
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Transport } from "../src/client/transport.js";
import { runFlowTest } from "../src/client/test_widget.js";
import { ApiError } from "../src/schema/envelope.js";
import type { Client } from "../src/client/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FLOW_UUID = "aaaaaaaa-0000-0000-0000-000000000001";
const AGENT_UUID = "agent-1-0000-0000-0000-000000000001";
const WIDGET_URL = "https://aiployee.jobix.ai/widget/abc";

const EXPECTED_HINT =
  "Open this URL in your browser to start a test conversation with the flow. After you finish, call get_flow_run to read the transcript.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelope(result: unknown): string {
  return JSON.stringify({ success: true, code: 200, result, errors: null });
}

function errorEnvelope(message: string, code = 400): string {
  return JSON.stringify({ success: false, code, result: null, errors: message });
}

function fakeResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

/** Wire shape for a connect_call_agent node (as returned by GET /v1/flows/<uuid>/nodes). */
function connectCallAgentNode(agentUuid: string): Record<string, unknown> {
  return {
    uuid: "cccccccc-0000-0000-0000-000000000003",
    name: "Connect Agent",
    number: 1,
    status: 1,
    type: "connect_call_agent",
    position: { x: 0, y: 0 },
    data: {
      connect_agent_params: {
        uuid: agentUuid,
        type: "ai",
        copy: false,
        prompt: null,
        phone_numbers: [],
      },
      actions: [],
    },
    outputs: [],
    inputs: [],
    connections: [],
  };
}

/** Wire shape for a non-agent node. */
function someOtherNode(): Record<string, unknown> {
  return {
    uuid: "dddddddd-0000-0000-0000-000000000004",
    name: "Inbound Call",
    number: 1,
    status: 1,
    type: "inbound_call",
    position: { x: 0, y: 0 },
    data: {
      phone_numbers: [],
      cancel_prev_executing: false,
    },
    outputs: [],
    inputs: [],
    connections: [],
  };
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

function makeClient(fetchImpl: typeof fetch): Client {
  const transport = new Transport({
    apiBase: "https://api.example.com",
    token: "test-token",
    fetchImpl,
  });

  const c = {
    transport,
    getFlowNodes(uuid: string) {
      return transport.request<unknown[]>({ method: "GET", path: `/flows/${uuid}/nodes` });
    },
  } as unknown as Client;

  return c;
}

// ---------------------------------------------------------------------------
// Test 1: Happy path — first-try {flow_uuid} succeeds with widget_url
// ---------------------------------------------------------------------------

describe("runFlowTest — happy path: first-try flow_uuid with widget_url field", () => {
  it("POSTs once with {flow_uuid} and returns widgetUrl + hint", async () => {
    let postCount = 0;
    let capturedBody: unknown;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/temporary-agent-widget")) {
        postCount++;
        capturedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return fakeResponse(envelope({ widget_url: WIDGET_URL }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const c = makeClient(fetchImpl);
    const result = await runFlowTest(c, { flowUuid: FLOW_UUID });

    assert.equal(postCount, 1, "POST should fire exactly once");
    assert.deepEqual(capturedBody, { flow_uuid: FLOW_UUID }, "body should be {flow_uuid}");
    assert.equal(result.widgetUrl, WIDGET_URL);
    assert.equal(result.hint, EXPECTED_HINT);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Field-name fallback — response has `url` not `widget_url`
// ---------------------------------------------------------------------------

describe("runFlowTest — field-name fallback: url field", () => {
  it("extracts widgetUrl from `url` when widget_url is absent", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/temporary-agent-widget")) {
        return fakeResponse(envelope({ url: WIDGET_URL }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const c = makeClient(fetchImpl);
    const result = await runFlowTest(c, { flowUuid: FLOW_UUID });
    assert.equal(result.widgetUrl, WIDGET_URL);
  });
});

// ---------------------------------------------------------------------------
// Test 3: String result — response.result is a plain string
// ---------------------------------------------------------------------------

describe("runFlowTest — string result", () => {
  it("uses the string directly when result is a plain URL string", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/temporary-agent-widget")) {
        return fakeResponse(envelope(WIDGET_URL));
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const c = makeClient(fetchImpl);
    const result = await runFlowTest(c, { flowUuid: FLOW_UUID });
    assert.equal(result.widgetUrl, WIDGET_URL);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Pivot path — 400 with "agent_uuid required", node found
// ---------------------------------------------------------------------------

describe("runFlowTest — pivot path: 400 agent_uuid error, connect_call_agent node present", () => {
  it("retries with {agent_uuid} from the first connect_call_agent node", async () => {
    let firstPost = false;
    let secondPost = false;
    let secondPostBody: unknown;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);

      if (url.includes("/temporary-agent-widget")) {
        if (!firstPost) {
          firstPost = true;
          // First attempt fails with 400 mentioning agent_uuid
          return fakeResponse(errorEnvelope("agent_uuid required"), 200);
        }
        // Second attempt succeeds
        secondPost = true;
        secondPostBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        return fakeResponse(envelope({ widget_url: WIDGET_URL }));
      }

      // getFlow calls: GET /v1/flows/<uuid>/nodes
      if (url.includes("/nodes")) {
        return fakeResponse(envelope([connectCallAgentNode(AGENT_UUID)]));
      }

      // getFlow may also call GET /v1/flows for the name
      if (url.endsWith("/flows") || url.includes("/flows?")) {
        return fakeResponse(
          envelope([{ uuid: FLOW_UUID, name: "Test Flow", status: "Inactive", updated_at: "2026-05-12T00:00:00Z" }]),
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    };

    const c = makeClient(fetchImpl);
    const result = await runFlowTest(c, { flowUuid: FLOW_UUID });

    assert.ok(firstPost, "first POST should have fired");
    assert.ok(secondPost, "second POST should have fired");
    assert.deepEqual(secondPostBody, { agent_uuid: AGENT_UUID }, "second POST body should use agent_uuid");
    assert.equal(result.widgetUrl, WIDGET_URL);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Pivot with no agent node — should throw
// ---------------------------------------------------------------------------

describe("runFlowTest — pivot path: 400 agent_uuid error, no connect_call_agent node", () => {
  it("throws 'no connect_call_agent node' when flow has no agent node", async () => {
    let firstPost = false;

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);

      if (url.includes("/temporary-agent-widget")) {
        if (!firstPost) {
          firstPost = true;
          return fakeResponse(errorEnvelope("agent_uuid required"), 200);
        }
        throw new Error("second POST should not have been called");
      }

      if (url.includes("/nodes")) {
        return fakeResponse(envelope([someOtherNode()]));
      }

      if (url.endsWith("/flows") || url.includes("/flows?")) {
        return fakeResponse(
          envelope([{ uuid: FLOW_UUID, name: "Test Flow", status: "Inactive", updated_at: "2026-05-12T00:00:00Z" }]),
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    };

    const c = makeClient(fetchImpl);

    await assert.rejects(
      () => runFlowTest(c, { flowUuid: FLOW_UUID }),
      (err: Error) => {
        assert.ok(
          err.message.includes("no connect_call_agent node"),
          `expected 'no connect_call_agent node' in: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Test 6: CR/LF in flowUuid — throws before any fetch
// ---------------------------------------------------------------------------

describe("runFlowTest — CR/LF in flowUuid", () => {
  it("throws before any fetch when flowUuid contains CR", async () => {
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return fakeResponse(envelope({}));
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () => runFlowTest(c, { flowUuid: "abc\rdef" }),
      (err: Error) => {
        assert.ok(err.message.includes("CR/LF") || err.message.includes("illegal"), `unexpected: ${err.message}`);
        return true;
      },
    );
    assert.equal(fetchCalled, false, "fetch should not have been called");
  });

  it("throws before any fetch when flowUuid contains LF", async () => {
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return fakeResponse(envelope({}));
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () => runFlowTest(c, { flowUuid: "abc\ndef" }),
      (err: Error) => {
        assert.ok(err.message.includes("CR/LF") || err.message.includes("illegal"), `unexpected: ${err.message}`);
        return true;
      },
    );
    assert.equal(fetchCalled, false, "fetch should not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 7: Empty flowUuid — throws before any fetch
// ---------------------------------------------------------------------------

describe("runFlowTest — empty flowUuid", () => {
  it("throws before any fetch when flowUuid is empty string", async () => {
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return fakeResponse(envelope({}));
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () => runFlowTest(c, { flowUuid: "" }),
      (err: Error) => {
        assert.ok(err.message.length > 0);
        return true;
      },
    );
    assert.equal(fetchCalled, false, "fetch should not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 8: Unrecognized response shape — should throw with "could not find widget URL"
// ---------------------------------------------------------------------------

describe("runFlowTest — unrecognized response shape", () => {
  it("throws 'could not find widget URL' when result has no recognized URL field", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/temporary-agent-widget")) {
        return fakeResponse(envelope({ something_else: "unrecognized" }));
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const c = makeClient(fetchImpl);

    await assert.rejects(
      () => runFlowTest(c, { flowUuid: FLOW_UUID }),
      (err: Error) => {
        assert.ok(
          err.message.includes("could not find widget URL"),
          `expected 'could not find widget URL' in: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// Re-export ApiError to silence unused-import warning if any linter runs
void ApiError;
