# aiployee-bridge — Phase 7: Activation + Test/Run Loop

**Date:** 2026-05-12
**Status:** Ready for subagent-driven execution.
**Prerequisites:**
- Phases 0–6.5 committed; v0.1.0 + Phase 6 is in `main`.
- Recon doc `recon/notes/04-activate-and-runs.md` is authoritative for endpoints.

## Goal

Close the "build → validate → **activate** → **observe**" loop. Currently the bridge can build flows but not ship them to production. Phase 7 adds:

- `set_flow_status` — explicit-confirmation activation/deactivation.
- `list_flow_runs` / `get_flow_run` — read past conversations.
- `run_flow_test` — return a test-widget URL the user opens manually.

## Locked design decisions (from the user)

1. **Confirmation token = the flow's exact `name`.** No magic string; user has to type the flow name as a confirmation field. Forces the user to identify which flow they're activating.
2. **Phone-collision policy = refuse only.** If an `Active` flow already claims an inbound number, the bridge throws with the conflicting flow's UUID. Bridge does NOT offer to deactivate the other flow — that's a multi-flow decision the LLM caller can do separately if the user wants.
3. **`run_flow_test` ships.** Returns a `{widgetUrl}` that the user opens manually. The bridge does not attempt to drive the chat headlessly.

## Cross-cutting constraints (carry over from Phase 6)

- Strict TS, exactOptionalPropertyTypes, noUncheckedIndexedAccess. Conditional spreads.
- No new dependencies.
- `success === true` is the gate, not HTTP 200.
- Tool surface stays clean DTOs; Yii bracket notation buried.
- Sandbox-only for live tests: flow `b2deacdb-…`, agent `3527076a-…`, number `+27877295318`.

## Task 7.1 — `set_flow_status` (verified endpoint, safety logic the load-bearing part)

### Files

- `src/client/flow_status.ts` (new)
- Extend `src/tools/flows.ts` (existing) — add `setFlowStatus`.
- Extend `src/mcp-server.ts` — register `set_flow_status` MCP tool.

### Behaviour

```ts
export async function setFlowStatus(
  c: Client,
  args: {
    uuid: string;
    status: "Active" | "Inactive";
    /** Must exactly equal the flow's current `name` field. */
    confirm: string;
  },
): Promise<{
  previousStatus: "Active" | "Inactive";
  newStatus: "Active" | "Inactive";
  changed: boolean;
  /** Inbound phone numbers that became live (when activating) or stopped routing (when deactivating). Empty when changed === false. */
  phoneNumbersAffected: string[];
}>;
```

### Step-by-step

1. **Local validation (before any network call):**
   - `args.status` ∈ `["Active", "Inactive"]` (zod enum).
   - `args.uuid` is a non-empty UUID string.
   - `args.confirm` is a non-empty string.
2. **GET state.** Call `listFlows(c)` (existing tool). Find the matching row. If not found, throw `Error("flow not found: <uuid>")`.
3. **Confirm-token check.** `args.confirm` MUST equal the flow's `name` exactly. Mismatch throws `Error("confirm token did not match the flow's name; expected '<flow.name>' got '<args.confirm>'")` — quoting the EXPECTED (the flow's actual name) is the whole point.
4. **No-op short-circuit.** If `flow.status === args.status`, return `{previousStatus: flow.status, newStatus: flow.status, changed: false, phoneNumbersAffected: []}`. Do NOT PATCH (the toggle endpoint would flip it).
5. **Pre-activate validation.** When transitioning Inactive → Active:
   - Run `getFlow(c, uuid)` to fetch nodes.
   - Run `validateFlowLocal(<dto>)` — if any `severity: "error"` issues, throw `Error("flow has validation errors; cannot activate: <JSON.stringify(issues)>")`.
   - **Phone-collision check:** collect every `inbound_call` node's `phoneNumbers` in this flow. For every OTHER flow in `listFlows` where `status === "Active"`, call `getFlow` and collect THEIR inbound phone numbers. If any number appears in both sets, throw `Error("inbound phone collision: number '<value>' is already claimed by Active flow '<other.name>' (<other.uuid>); deactivate that flow first if you intend to take over the number")`. List ALL collisions, not just the first.
6. **Toggle.** `await c.transport.request({method: "PATCH", path: \`/flows/\${uuid}/activate\`, body: {}})`. The bearer-auth `Transport` handles the envelope.
7. **Verify.** Re-call `listFlows(c)`; assert the flow's `status` now matches `args.status`. If not, throw `Error("toggle PATCH succeeded but flow status is still <X>; possible server-side rejection or race")`.
8. **Return** `{previousStatus, newStatus, changed: true, phoneNumbersAffected: <inbound numbers in this flow>}`.

### MCP tool registration

| Tool name | Input schema | Returns |
|---|---|---|
| `set_flow_status` | `{uuid: string, status: "Active" \| "Inactive", confirm: string}` | The DTO above. |

The MCP tool's description text MUST include the exact requirement that `confirm` is the flow's name AND the collision-refusal behaviour, so the LLM's tool-selection layer surfaces it to the user before invoking.

### Tests (`tests/flow_status.test.ts`)

1. Confirm-token mismatch throws before any PATCH.
2. Status already matches → returns `{changed: false}` and never PATCHes (assert `patchCalled === false`).
3. Inactive → Active with a validation-failing flow → throws (no PATCH).
4. Inactive → Active with a phone collision (mock another active flow with the same inbound number) → throws naming BOTH flow UUIDs (this and the conflicting one).
5. Inactive → Active happy path → asserts PATCH fires once with empty body, verify re-fetch, returns `changed: true` + the phone numbers.
6. Active → Inactive happy path → ditto, returns `changed: true`.

All use injected `fetchImpl`. No real network.

### Live integration (added to `tests/integration-yii.test.ts` or a new `tests/integration-status.test.ts`)

A sandbox-safe live test: read sandbox flow's status, call `setFlowStatus` with the SAME status (no-op path), assert `changed === false` and no mutation occurred. Don't exercise the activate path on the live sandbox — the sandbox flow is empty and validation would refuse, but defence-in-depth says don't try.

## Task 7.2 — `list_flow_runs` (Yii listing scrape)

### Files

- `src/client/flow_runs.ts` (new)
- `src/tools/flow_runs.ts` (new)
- Extend `src/mcp-server.ts`.

### DTO

```ts
export interface FlowRunSummary {
  uuid: string;
  flowUuid: string | null;
  agentUuid: string | null;
  startedAt: string;       // ISO 8601 if parseable, else raw
  durationS: number | null;
  status: string;          // e.g. "completed", "transferred", "failed" — observed string
  channel: string;         // "inbound_call", "internet_call", etc.
}

export async function listFlowRuns(
  c: Client,
  args?: { flowUuid?: string; limit?: number },
): Promise<FlowRunSummary[]>;
```

### Behaviour

1. `YiiTransport.getForm("/calls", { formId: undefined })` — or just a plain GET via `yiiTransport.fetchImpl` since this isn't a form, it's a listing.
2. Parse the row table. Each row link points at `/calls/<uuid>/details`; the surrounding cells hold timestamp, status badge, channel, duration, agent reference. Build a minimal HTML row parser that extracts every `<tr>` matching the pattern and pulls cells by position.
3. Filter by `flowUuid` client-side if specified.
4. Limit to `limit` (default 25; cap at 200).
5. Surface a parsing error LOUDLY if the row structure shifts — fail fast with the offending HTML snippet (truncated to 400 chars) so future drift is detectable.

### Unknown — to verify during implementation

- Whether `/calls?flow_uuid=…` query-param filter works server-side. Try `/calls?flow_uuid=<sandbox uuid>` first; if the response excludes other flows, use server-side filter; otherwise client-side.
- Exact CSS classes / column order on the row. The implementer fetches one `/calls` page during development and writes the parser against the live HTML; commits a sample fixture to `tests/`.

### Tests

Inline HTML fixture with 3 rows (different channels, one for flowUuid X and two for flowUuid Y). Assert `listFlowRuns({flowUuid: X})` returns one row; `listFlowRuns({limit: 2})` returns the first two by table order.

## Task 7.3 — `get_flow_run` (Yii detail page scrape)

### Files

- Extend `src/client/flow_runs.ts`.
- Extend `src/tools/flow_runs.ts`.
- Extend `src/mcp-server.ts`.

### DTO

```ts
export interface FlowRunDetail extends FlowRunSummary {
  /** Transcript entries in order. role is "agent" | "customer" | "system". */
  transcript: { role: string; text: string; tsMs?: number }[];
  /** Which nodes fired in what order, with the data each emitted. Optional — present when the platform exposes it on the page. */
  nodePath?: { dataKey: string; type: string; outcome?: string }[];
  /** Free-form metadata visible on the detail page (status reason, agent name, etc.). */
  metadata: Record<string, string>;
}

export async function getFlowRun(c: Client, uuid: string): Promise<FlowRunDetail>;
```

### Behaviour

1. GET `/calls/<uuid>/details` via the Yii session.
2. Parse the HTML for: top metadata block (status, duration, started/ended, agent, channel), the transcript section, and optionally a "node path" / "decision log" block if the page renders one.
3. The transcript HTML structure is unverified — implementer reads one live page during development and writes the parser. Commit a sample fixture (PII-redacted) to `tests/`.

### Tests

Inline transcript fixture; assert `getFlowRun` returns the expected list of turns, metadata fields, and node path entries.

## Task 7.4 — `run_flow_test`

### Files

- `src/client/test_widget.ts` (new)
- `src/tools/test_widget.ts` (new)
- Extend `src/mcp-server.ts`.

### Behaviour

```ts
export async function runFlowTest(
  c: Client,
  args: { flowUuid: string },
): Promise<{
  widgetUrl: string;
  /** Optional message the bridge surfaces alongside the URL (e.g. "open this in a browser; the test agent will run end-to-end"). */
  hint: string;
}>;
```

1. POST `/v1/temporary-agent-widget` with `{flow_uuid: args.flowUuid}` (best-guess body shape; if it's `{agent_uuid: ...}` instead, the implementer pivots after the first try).
2. Response should include a `widgetUrl` field or similar — extract it from the envelope's `result`.
3. Return `{widgetUrl, hint: "Open this URL in your browser to start a test conversation with the flow. The conversation will appear in get_flow_run once it completes."}`.

### Implementation gotcha

If the `/v1/temporary-agent-widget` endpoint doesn't accept a flow uuid (only an agent uuid), pivot: read the flow's trigger node, find its connected `connect_call_agent`'s `agent_uuid`, pass that. Surface this clearly in the error so the caller knows what happened.

### Tests

Mock `fetchImpl`; assert the POST fires with the right body and the returned `widgetUrl` matches the envelope's `result.widget_url` (or whatever the live endpoint returns; fixture matches live shape).

## Task 7.5 — README + integration test

Update `README.md` "Tools exposed" with the four new tools, and "Failure modes worth knowing" with one bullet on `set_flow_status` (the confirmation requirement and the collision-refusal).

Live integration test (env-gated as ever):

1. `setFlowStatus` no-op path on sandbox flow (status already Inactive, target Inactive → `changed: false`).
2. `listFlowRuns()` — assert at least one run exists in the live tenant (the demo tenant has dozens).
3. `getFlowRun(<one uuid from step 2>)` — assert transcript array is non-empty and metadata has `status` and `channel`.

`runFlowTest` is NOT live-tested — calling it would create a real test widget session that the human would have to clean up manually.

## Out of scope for Phase 7

- A "tail flow runs" / live-streaming endpoint — only point-in-time reads.
- Editing past conversations (impossible by design).
- The bonus endpoints from recon 04's table (`/v1/nodes/run`, `/v1/email/send-test`, etc.) — Phase 8+ if needed.

## Commit hygiene

- One commit per task, conventional-commit style (`phase 7.N: …`).
- Tests committed alongside the code they verify.
- README updated once at the end of 7.5.
