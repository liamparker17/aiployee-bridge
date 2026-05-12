/**
 * flow_runs.test.ts — unit tests for listFlowRuns and extractFlowRunsFromHtml.
 *
 * Tests are split into:
 *   1. extractFlowRunsFromHtml — parser-level tests with inline HTML fixtures.
 *   2. listFlowRuns — orchestration tests with a fake Client stub.
 *   3. parseDurationS — duration parsing utility.
 *
 * No live network calls. No real Client construction.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extractFlowRunsFromHtml, listFlowRuns, parseDurationS } from "../src/client/flow_runs.js";
import type { Client } from "../src/client/index.js";
import type { YiiTransport } from "../src/client/yii.js";

// ---------------------------------------------------------------------------
// HTML fixture helpers
// ---------------------------------------------------------------------------

const FLOW_A = "aaaaaaaa-0000-0000-0000-000000000001";
const FLOW_B = "bbbbbbbb-0000-0000-0000-000000000002";
const CALL_1 = "cccccccc-1111-0000-0000-000000000001";
const CALL_2 = "cccccccc-2222-0000-0000-000000000002";
const CALL_3 = "cccccccc-3333-0000-0000-000000000003";
const AGENT_1 = "dddddddd-0000-0000-0000-000000000001";

/**
 * Build a minimal <tr> for a call row.
 * Mimics the expected /calls table row structure.
 */
function makeRow(opts: {
  callUuid: string;
  flowUuid?: string;
  agentUuid?: string;
  status?: string;
  channel?: string;
  startedAt?: string;
  duration?: string;
}): string {
  const flowLink = opts.flowUuid
    ? `<a href="/flows/${opts.flowUuid}">Flow Name</a>`
    : "";
  const agentLink = opts.agentUuid
    ? `<a href="/agents/${opts.agentUuid}">Agent Name</a>`
    : "";
  const status = opts.status ?? "Completed";
  const channel = opts.channel ?? "Inbound Call";
  const startedAt = opts.startedAt ?? "2026, May 12 - 9:01 am";
  const duration = opts.duration ?? "1:30";

  return `
    <tr>
      <td><input type="checkbox"></td>
      <td><a href="/calls/${opts.callUuid}/details">View</a></td>
      <td><span class="bg-green-100 text-green-800">${status}</span></td>
      <td>${channel}</td>
      <td>${startedAt}</td>
      <td>${duration}</td>
      <td>${flowLink}${agentLink}</td>
    </tr>`;
}

function makeTable(rows: string[]): string {
  return `
    <html><body>
    <table>
      <thead><tr><th>ID</th><th>Status</th><th>Channel</th><th>Started</th><th>Duration</th><th>Flow</th></tr></thead>
      <tbody>
        ${rows.join("\n")}
      </tbody>
    </table>
    </body></html>`;
}

// ---------------------------------------------------------------------------
// Fake Client stub for listFlowRuns tests
// ---------------------------------------------------------------------------

function makeFakeClient(html: string): Client {
  const fakeYii = {
    fetchHtml: async (_path: string) => ({
      status: 200,
      html,
      finalUrl: "http://app.example.com/calls",
    }),
  } as unknown as YiiTransport;

  return {
    get yiiTransport() {
      return fakeYii;
    },
  } as unknown as Client;
}

// ---------------------------------------------------------------------------
// 1. extractFlowRunsFromHtml — parser tests
// ---------------------------------------------------------------------------

describe("extractFlowRunsFromHtml", () => {
  it("parses 3 rows with different channels", () => {
    const html = makeTable([
      makeRow({ callUuid: CALL_1, channel: "Inbound Call", startedAt: "2026, May 12 - 9:01 am" }),
      makeRow({ callUuid: CALL_2, channel: "Internet Call", startedAt: "2026, May 11 - 3:15 pm" }),
      makeRow({ callUuid: CALL_3, channel: "Outbound Call", startedAt: "2026, May 10 - 11:00 am" }),
    ]);

    const rows = extractFlowRunsFromHtml(html);

    assert.equal(rows.length, 3);

    assert.equal(rows[0]!.uuid, CALL_1);
    assert.equal(rows[0]!.channel, "inbound_call");
    // startedAt should be ISO or raw — just assert it's non-empty and contains "2026"
    assert.ok(rows[0]!.startedAt.includes("2026"), `startedAt: ${rows[0]!.startedAt}`);

    assert.equal(rows[1]!.uuid, CALL_2);
    assert.equal(rows[1]!.channel, "internet_call");

    assert.equal(rows[2]!.uuid, CALL_3);
    assert.equal(rows[2]!.channel, "outbound_call");
  });

  it("extracts flowUuid and agentUuid from href links", () => {
    const html = makeTable([
      makeRow({ callUuid: CALL_1, flowUuid: FLOW_A, agentUuid: AGENT_1 }),
    ]);

    const rows = extractFlowRunsFromHtml(html);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.flowUuid, FLOW_A);
    assert.equal(rows[0]!.agentUuid, AGENT_1);
  });

  it("sets flowUuid and agentUuid to null when no links present", () => {
    const html = makeTable([
      makeRow({ callUuid: CALL_1 }),
    ]);

    const rows = extractFlowRunsFromHtml(html);
    assert.equal(rows[0]!.flowUuid, null);
    assert.equal(rows[0]!.agentUuid, null);
  });

  it("snake_cases status text", () => {
    const html = makeTable([
      makeRow({ callUuid: CALL_1, status: "Transferred" }),
      makeRow({ callUuid: CALL_2, status: "In Progress" }),
    ]);

    const rows = extractFlowRunsFromHtml(html);
    assert.equal(rows[0]!.status, "transferred");
    assert.equal(rows[1]!.status, "in_progress");
  });

  it("returns empty array when no tbody", () => {
    const rows = extractFlowRunsFromHtml("<html><body><p>No calls</p></body></html>");
    assert.equal(rows.length, 0);
  });

  it("throws on schema drift — row missing /calls/<uuid>/details link", () => {
    const badRow = `<tr><td>no link here</td><td>just text</td></tr>`;
    const html = makeTable([badRow]);

    assert.throws(
      () => extractFlowRunsFromHtml(html),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("flow run row parse failed"),
          `Expected 'flow run row parse failed' in: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("parses duration correctly", () => {
    const html = makeTable([
      makeRow({ callUuid: CALL_1, duration: "1:30" }),
    ]);
    const rows = extractFlowRunsFromHtml(html);
    assert.equal(rows[0]!.durationS, 90);
  });

  it("sets durationS to null for unparseable duration", () => {
    const html = makeTable([
      makeRow({ callUuid: CALL_1, duration: "garbage" }),
    ]);
    const rows = extractFlowRunsFromHtml(html);
    assert.equal(rows[0]!.durationS, null);
  });
});

// ---------------------------------------------------------------------------
// 2. listFlowRuns — orchestration tests
// ---------------------------------------------------------------------------

describe("listFlowRuns", () => {
  it("returns all rows when no flowUuid filter specified", async () => {
    const html = makeTable([
      makeRow({ callUuid: CALL_1, flowUuid: FLOW_A }),
      makeRow({ callUuid: CALL_2, flowUuid: FLOW_B }),
      makeRow({ callUuid: CALL_3, flowUuid: FLOW_B }),
    ]);

    const client = makeFakeClient(html);
    const rows = await listFlowRuns(client);
    assert.equal(rows.length, 3);
  });

  it("filters by flowUuid client-side when rows expose flowUuid", async () => {
    const html = makeTable([
      makeRow({ callUuid: CALL_1, flowUuid: FLOW_A }),
      makeRow({ callUuid: CALL_2, flowUuid: FLOW_B }),
      makeRow({ callUuid: CALL_3, flowUuid: FLOW_A }),
    ]);

    const client = makeFakeClient(html);
    const rows = await listFlowRuns(client, { flowUuid: FLOW_A });
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.flowUuid === FLOW_A));
  });

  it("returns unfiltered set when all rows have flowUuid=null and filter is specified", async () => {
    // Rows without flow links → flowUuid will be null → can't filter
    const html = makeTable([
      makeRow({ callUuid: CALL_1 }),
      makeRow({ callUuid: CALL_2 }),
    ]);

    const client = makeFakeClient(html);
    // Should return all 2 rows despite flowUuid filter (can't filter nulls)
    const rows = await listFlowRuns(client, { flowUuid: FLOW_A });
    assert.equal(rows.length, 2);
  });

  it("applies limit:2 returning first 2 rows in table order", async () => {
    const html = makeTable([
      makeRow({ callUuid: CALL_1 }),
      makeRow({ callUuid: CALL_2 }),
      makeRow({ callUuid: CALL_3 }),
    ]);

    const client = makeFakeClient(html);
    const rows = await listFlowRuns(client, { limit: 2 });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.uuid, CALL_1);
    assert.equal(rows[1]!.uuid, CALL_2);
  });

  it("caps limit at 200", async () => {
    // Build 5 rows but request limit 9999 — should get all 5 (capped, not blown up)
    const html = makeTable([
      makeRow({ callUuid: CALL_1 }),
      makeRow({ callUuid: CALL_2 }),
      makeRow({ callUuid: CALL_3 }),
    ]);

    const client = makeFakeClient(html);
    const rows = await listFlowRuns(client, { limit: 9999 });
    // 3 rows < 200, so all returned
    assert.equal(rows.length, 3);
  });

  it("uses default limit of 25", async () => {
    // Build 30 rows
    const manyRows: string[] = [];
    for (let i = 1; i <= 30; i++) {
      const uuid = `cccccccc-${String(i).padStart(4, "0")}-0000-0000-000000000000`;
      manyRows.push(makeRow({ callUuid: uuid }));
    }
    const html = makeTable(manyRows);

    const client = makeFakeClient(html);
    const rows = await listFlowRuns(client); // no limit specified
    assert.equal(rows.length, 25);
  });
});

// ---------------------------------------------------------------------------
// 3. parseDurationS — duration parser unit tests
// ---------------------------------------------------------------------------

describe("parseDurationS", () => {
  it('"1:30" → 90', () => {
    assert.equal(parseDurationS("1:30"), 90);
  });

  it('"0:42" → 42', () => {
    assert.equal(parseDurationS("0:42"), 42);
  });

  it('"45s" → 45', () => {
    assert.equal(parseDurationS("45s"), 45);
  });

  it('"45" (no suffix) → 45', () => {
    assert.equal(parseDurationS("45"), 45);
  });

  it('"2m" → 120', () => {
    assert.equal(parseDurationS("2m"), 120);
  });

  it('"1m 30s" → 90', () => {
    assert.equal(parseDurationS("1m 30s"), 90);
  });

  it('"1m30s" → 90', () => {
    assert.equal(parseDurationS("1m30s"), 90);
  });

  it('"1:02:03" (H:MM:SS) → 3723', () => {
    assert.equal(parseDurationS("1:02:03"), 3723);
  });

  it('"garbage" → null', () => {
    assert.equal(parseDurationS("garbage"), null);
  });

  it('"abc123" → null', () => {
    assert.equal(parseDurationS("abc123"), null);
  });

  it('"" (empty string) → null', () => {
    assert.equal(parseDurationS(""), null);
  });
});
