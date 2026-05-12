# aiployee-bridge — Recon 04: Activation + Test/Run Loop

**Date:** 2026-05-12
**Status:** Read-only. No mutations.
**Closes the gaps** flagged for `set_flow_status` and the test/observe pair (`run_flow_test`, `get_flow_run`).

## Headline findings

1. **Status is a single TOGGLE endpoint, not separate activate/deactivate.**
   `PATCH /v1/flows/<uuid>/activate` with body `{}` flips state both ways. The bridge MUST read current state first (via `list_flows`) and only PATCH when a change is desired; otherwise it's a no-op… actually, since the endpoint always flips, calling it when current state already matches the desired state would invert it. Read-then-conditional-patch is mandatory.
2. **`/v1/nodes/run` is per-node, not flow-level.** It runs Filter / Condition / LLM nodes with given inputs. Useful but not the closing-loop test we want.
3. **Conversations are Yii-rendered.** `/calls` and `/calls/<uuid>/details` are server-rendered HTML, no JSON API. The bridge scrapes with the same `YiiTransport` it uses for Agents / Custom Fields / Contacts.
4. **End-to-end test mechanism:** the agent edit page has "Live Chat & Internet Call" and "Live Outbound Call" buttons that spawn a `/v1/temporary-agent-widget` session (spotted in inline scripts earlier). The bridge can return the widget URL; the user opens it manually to test.

## Verified evidence (from `nodular.js` — the Angular SPA's API binding layer)

The `nodular.js` file is unminified (27 KB). The toggle handler:

```js
listenActivateToggle: function () {
  let component = this.component;
  component.addEventListener('on_active_toggle', event => {
    if (!(event && event.detail && event.detail.uuid)) return;
    this.makePatchRequest(
      `/v1/flows/${event.detail.uuid}/activate`,
      {},
      data => { component.setAttribute('set_active_toggle', JSON.stringify(data)); },
      xhr  => { component.setAttribute('set_active_toggle', JSON.stringify(xhr.responseJSON)); }
    );
  });
}
```

- Method: **PATCH**
- Path: `/v1/flows/<uuid>/activate`
- Body: `{}`
- Auth: bearer (same as the rest of `/v1/*`)
- Response: returned `data` (envelope-wrapped, presumably `{success, code, result, errors}` like every other `/v1/*` call)

## Other endpoints discovered in the same pass (bonus, not in Phase 7 scope)

| Endpoint | Method | Purpose |
|---|---|---|
| `POST /v1/nodes/run` | POST | Runs a specific node for testing. Body: `{sort, limit, nodes, flow_uuid, node_number}`. Useful for unit-testing a Filter/Condition node, not for end-to-end flow test. |
| `POST /v1/nodes/evaluate` | POST | Evaluates filter rules with sample data. Body: `{flow_uuid, filters, nodes}`. |
| `POST /v1/nodes/filter-count` | POST | Counts how many records match a filter. |
| `POST /v1/flows/statistic` | POST | Aggregated stats for a flow. Body: `{flow_uuid, filters, nodes}`. |
| `POST /v1/email/send-test` | POST | Sends a test email from an Email node. |
| `POST /v1/email/preview` | POST | Renders the HTML preview of an Email node. |
| `POST /v1/r/send-test-api-request` | POST | Tests a Webhook (API Request) node. |
| `POST /v1/r/llm-test-request` | POST | Tests an LLM (`ai_data_generation`) node. |
| `GET /v1/r/customers-emails-dropdown` | GET | Dropdown of customer emails. |
| `GET /v1/r/sms-providers-dropdown` | GET | Dropdown of SMS providers. |
| `GET /v1/r/llm-providers-dropdown` | GET | Dropdown of LLM providers. |
| `POST /v1/nodes` | POST | Possibly creates a single node. Unverified. |

These are flagged for future phases — none affect Phase 7 directly.

## Conversations / call records

The Conversations sidebar item lives at `/calls` (Yii-rendered listing). Detail URL pattern: `/calls/<uuid>/details`. Both are HTML pages — same auth as the rest of the Yii side (PHPSESSID/_identity/_csrf cookies via `YiiTransport`).

The listing page has table rows whose link cells point at `/calls/<uuid>/details`. 25 rows per page; pagination presumed. To get a flow-filtered view, the bridge will likely have to:
- GET `/calls` (full listing) and filter client-side, OR
- Find a query-param filter (e.g. `?flow_uuid=…`) — needs one extra check during build-time.

For now the plan assumes a client-side filter; if the URL has a query-param filter, swap it in trivially.

## Test/observe loop — `run_flow_test` re-scoped

Given the recon, the "test before going live" pair becomes:

| Tool | Backed by | What the LLM caller does |
|---|---|---|
| `run_flow_test({flowUuid})` | Triggers a `/v1/temporary-agent-widget` session (or returns the URL of the Live Chat button on the editor) | Receives `{widgetUrl}` and tells the user "open this URL in your browser to test." The bridge cannot drive an interactive chat headlessly. |
| `list_flow_runs({flowUuid, limit?})` | Yii GET `/calls` + client-side filter | Returns recent call summaries (`{uuid, agent_uuid, started_at, duration_s, status, channel}`). |
| `get_flow_run({uuid})` | Yii GET `/calls/<uuid>/details` | Returns the transcript + per-node-path data so the LLM can debug "why did the agent take the Transferred branch on call X". |

This is the closing-loop pair. The `run_flow_test` tool is honest about what it can do — it spawns a test target; the human interacts. `get_flow_run` then closes the loop on what happened.

## What this means for `set_flow_status`

The bridge's `set_flow_status` flow:

1. Validate input: `status` ∈ `{"Active", "Inactive"}`; `confirm` must equal the flow's current `name` exactly (per locked decision).
2. Read current state via `list_flows` (find the flow's row).
3. If current === desired, return `{previousStatus, newStatus, changed: false}` and DON'T patch.
4. If different:
   - Run `validate_flow` server-side; if any error-severity issues, throw.
   - If activating to `Active`: read the flow's nodes; for any `inbound_call` node, read its `phone_numbers`; check no OTHER `Active` flow already claims the same number (via `list_flows` filtered to active, then `getFlowNodes` on each, looking for inbound_call nodes — fan-out cost is bounded since most tenants have <50 active flows). On collision, throw with the conflicting flow's UUID.
   - PATCH `/v1/flows/<uuid>/activate` with `{}`.
   - Re-read state via `list_flows` to confirm.
5. Return `{previousStatus, newStatus, changed: true, phoneNumbersAffected: string[]}`.

The toggle's single endpoint means the implementation is short, but the **collision check is the load-bearing safety logic** — that's what stops a careless `set_flow_status` from stealing a live number.

## Sandbox safety

The sandbox flow `b2deacdb-…` is currently **Inactive** (verified from the listing page badge). Integration tests for `set_flow_status` can flip it Inactive→Inactive (the read-then-patch logic correctly no-ops). Activating-then-deactivating is also safe because the flow has zero nodes — there's no phone number to bind. Still, the integration test must ensure it ends in the `Inactive` state regardless of path.

## Open questions for Phase 7 build-time

1. `/v1/temporary-agent-widget` — exact request shape (likely `{flow_uuid}` or `{agent_uuid}`). One UI button-click capture during 7.4 will reveal it. Defer.
2. Whether `/calls?flow_uuid=…` filter param works. Try; if not, client-side filter.
3. Conversation detail HTML — extracting the transcript will need a parser pass. The structure is unverified until 7.3.

None of these block 7.1 (`set_flow_status`) or 7.2 (`list_flow_runs`).
