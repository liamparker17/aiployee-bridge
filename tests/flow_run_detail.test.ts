/**
 * flow_run_detail.test.ts — unit tests for extractFlowRunDetailFromHtml
 * and getFlowRun.
 *
 * Inline HTML fixtures; no network. The detail page's real shape is
 * unverified — these fixtures exercise the patterns the parser supports
 * (dt/dd metadata, label/value pairs, data-role transcript, role-class
 * transcript, node-path tables).
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
  extractFlowRunDetailFromHtml,
  getFlowRun,
} from "../src/client/flow_run_detail.js";
import { YiiTransport } from "../src/client/yii.js";
import type { Client } from "../src/client/index.js";

const RUN_UUID = "aaaaaaaa-1111-2222-3333-444444444444";
const FLOW_UUID = "bbbbbbbb-1111-2222-3333-444444444444";
const AGENT_UUID = "cccccccc-1111-2222-3333-444444444444";

function fakeResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

/** Build a minimal duck-typed Client whose yiiTransport uses the given fetchImpl. */
function makeClient(fetchImpl: typeof fetch): Client {
  const yii = new YiiTransport({
    yiiHost: "https://yii.example.com",
    cookies: {
      PHPSESSID: "session-id",
      _identity: "identity",
      _csrf: "csrf-cookie",
    },
    fetchImpl,
  });

  return {
    yiiTransport: yii,
  } as unknown as Client;
}

// ---------------------------------------------------------------------------
// Case 1: DL-style metadata block with 4+ key/value pairs
// ---------------------------------------------------------------------------

describe("extractFlowRunDetailFromHtml - dt/dd metadata", () => {
  it("extracts status, channel, started_at, duration from <dt>/<dd> pairs", () => {
    const html = `
      <html><body>
        <dl>
          <dt>Status</dt><dd>Completed</dd>
          <dt>Channel</dt><dd>Inbound Call</dd>
          <dt>Started At</dt><dd>2026-05-12 09:30:00</dd>
          <dt>Duration</dt><dd>1:30</dd>
          <dt>Agent</dt><dd>Support Bot</dd>
        </dl>
      </body></html>
    `;
    const detail = extractFlowRunDetailFromHtml(RUN_UUID, html);
    assert.equal(detail.uuid, RUN_UUID);
    assert.equal(detail.status, "completed");
    assert.equal(detail.channel, "inbound_call");
    assert.equal(detail.startedAt, "2026-05-12 09:30:00");
    assert.equal(detail.durationS, 90);
    assert.equal(detail.metadata["status"], "Completed");
    assert.equal(detail.metadata["channel"], "Inbound Call");
    assert.equal(detail.metadata["started_at"], "2026-05-12 09:30:00");
    assert.equal(detail.metadata["duration"], "1:30");
    assert.equal(detail.metadata["agent"], "Support Bot");
  });
});

// ---------------------------------------------------------------------------
// Case 2: 3-turn transcript, entity-encoded character, roles normalised
// ---------------------------------------------------------------------------

describe("extractFlowRunDetailFromHtml - transcript via data-role", () => {
  it("captures role + text in order, decodes entities", () => {
    const html = `
      <div class="transcript">
        <div data-role="agent">Hello, how can I help you?</div>
        <div data-role="customer">I need help with my order &amp; invoice.</div>
        <div data-role="agent">Sure, let me check that.</div>
      </div>
    `;
    const detail = extractFlowRunDetailFromHtml(RUN_UUID, html);
    assert.equal(detail.transcript.length, 3);
    assert.deepEqual(detail.transcript.map((t) => t.role), [
      "agent",
      "customer",
      "agent",
    ]);
    assert.equal(detail.transcript[0]?.text, "Hello, how can I help you?");
    // Entity decoded
    assert.equal(detail.transcript[1]?.text, "I need help with my order & invoice.");
    assert.equal(detail.transcript[2]?.text, "Sure, let me check that.");
  });
});

// ---------------------------------------------------------------------------
// Case 3: Empty transcript - returns [] and does NOT throw
// ---------------------------------------------------------------------------

describe("extractFlowRunDetailFromHtml - empty page", () => {
  it("returns empty transcript without throwing when no message elements", () => {
    const html = `<html><body>
      <dl><dt>Status</dt><dd>Failed</dd></dl>
      <p>No conversation recorded.</p>
    </body></html>`;

    let detail: ReturnType<typeof extractFlowRunDetailFromHtml> | undefined;
    assert.doesNotThrow(() => {
      detail = extractFlowRunDetailFromHtml(RUN_UUID, html);
    });

    assert.ok(detail !== undefined);
    assert.deepEqual(detail!.transcript, []);
    assert.equal(detail!.uuid, RUN_UUID);
    assert.equal(detail!.status, "failed");
    assert.equal(detail!.channel, "unknown");
  });

  it("returns defaults when completely empty page", () => {
    const detail = extractFlowRunDetailFromHtml(RUN_UUID, "<html><body></body></html>");
    assert.equal(detail.uuid, RUN_UUID);
    assert.equal(detail.status, "unknown");
    assert.equal(detail.channel, "unknown");
    assert.equal(detail.transcript.length, 0);
    assert.equal(detail.flowUuid, null);
    assert.equal(detail.agentUuid, null);
    assert.deepEqual(detail.metadata, {});
  });
});

// ---------------------------------------------------------------------------
// Case 4a: nodePath present — populated on DTO
// ---------------------------------------------------------------------------

describe("extractFlowRunDetailFromHtml - nodePath table", () => {
  it("parses a node-path table when present", () => {
    const html = `
      <table class="node-path">
        <tr><td>greeting</td><td>connect_call_agent</td><td>Completed</td></tr>
        <tr><td>check_membership</td><td>filter</td><td>Transferred</td></tr>
        <tr><td>end_node</td><td>end</td></tr>
      </table>
    `;
    const detail = extractFlowRunDetailFromHtml(RUN_UUID, html);
    assert.ok(detail.nodePath, "nodePath should be present");
    assert.equal(detail.nodePath!.length, 3);
    assert.equal(detail.nodePath![0]?.dataKey, "greeting");
    assert.equal(detail.nodePath![0]?.type, "connect_call_agent");
    assert.equal(detail.nodePath![0]?.outcome, "Completed");
    assert.equal(detail.nodePath![1]?.outcome, "Transferred");
    // Third row has no outcome column
    assert.equal(detail.nodePath![2]?.outcome, undefined);
  });

  // Case 4b: nodePath absent — field is undefined (not present on the object)
  it("nodePath is undefined when no recognised table", () => {
    const detail = extractFlowRunDetailFromHtml(RUN_UUID, "<div>no table</div>");
    assert.equal(detail.nodePath, undefined);
    assert.ok(!("nodePath" in detail), "nodePath should not be present on the object");
  });
});

// ---------------------------------------------------------------------------
// flowUuid + agentUuid from href links
// ---------------------------------------------------------------------------

describe("extractFlowRunDetailFromHtml - flowUuid + agentUuid from links", () => {
  it("extracts flowUuid and agentUuid from /flows/ and /agents/ hrefs", () => {
    const html = `
      <p>Flow: <a href="/flows/${FLOW_UUID}">My Flow</a></p>
      <p>Agent: <a href="/agents/${AGENT_UUID}">My Agent</a></p>
    `;
    const detail = extractFlowRunDetailFromHtml(RUN_UUID, html);
    assert.equal(detail.flowUuid, FLOW_UUID);
    assert.equal(detail.agentUuid, AGENT_UUID);
  });

  it("returns null flowUuid/agentUuid when no relevant links", () => {
    const detail = extractFlowRunDetailFromHtml(RUN_UUID, "<p>no links</p>");
    assert.equal(detail.flowUuid, null);
    assert.equal(detail.agentUuid, null);
  });
});

// ---------------------------------------------------------------------------
// Role-class fallback transcript (Pattern B)
// ---------------------------------------------------------------------------

describe("extractFlowRunDetailFromHtml - transcript via role- class fallback", () => {
  it("uses class=message-* when no data-role present", () => {
    const html = `
      <ul>
        <li class="message-agent">Hello</li>
        <li class="message-customer">Hi there</li>
      </ul>
    `;
    const detail = extractFlowRunDetailFromHtml(RUN_UUID, html);
    assert.equal(detail.transcript.length, 2);
    assert.equal(detail.transcript[0]?.role, "agent");
    assert.equal(detail.transcript[0]?.text, "Hello");
    assert.equal(detail.transcript[1]?.role, "customer");
  });
});

// ---------------------------------------------------------------------------
// Case 5: getFlowRun — UUID validation
// ---------------------------------------------------------------------------

describe("getFlowRun - argument validation", () => {
  it("throws on empty uuid before any fetch", async () => {
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return fakeResponse("");
    };
    const c = makeClient(fetchImpl);
    await assert.rejects(() => getFlowRun(c, ""));
    assert.equal(fetchCalled, false, "fetch should not be called");
  });

  it("throws on LF in uuid before any fetch", async () => {
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return fakeResponse("");
    };
    const c = makeClient(fetchImpl);
    await assert.rejects(() => getFlowRun(c, "abc\nxyz"));
    assert.equal(fetchCalled, false, "fetch should not be called");
  });

  it("throws on CR in uuid before any fetch", async () => {
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return fakeResponse("");
    };
    const c = makeClient(fetchImpl);
    await assert.rejects(() => getFlowRun(c, "abc\rxyz"));
    assert.equal(fetchCalled, false, "fetch should not be called");
  });
});

// ---------------------------------------------------------------------------
// getFlowRun — happy path through Yii transport
// ---------------------------------------------------------------------------

describe("getFlowRun - happy path", () => {
  it("fetches /calls/<uuid>/details and parses the HTML", async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      capturedUrl = String(input);
      const html = `
        <dl>
          <dt>Status</dt><dd>Completed</dd>
          <dt>Channel</dt><dd>Inbound Call</dd>
        </dl>
        <div data-role="agent">Hello</div>
        <div data-role="customer">Hi back</div>
      `;
      return fakeResponse(html);
    };

    const c = makeClient(fetchImpl);
    const detail = await getFlowRun(c, RUN_UUID);

    assert.ok(capturedUrl.endsWith(`/calls/${RUN_UUID}/details`), `unexpected URL: ${capturedUrl}`);
    assert.equal(detail.uuid, RUN_UUID);
    assert.equal(detail.status, "completed");
    assert.equal(detail.channel, "inbound_call");
    assert.equal(detail.transcript.length, 2);
  });
});
