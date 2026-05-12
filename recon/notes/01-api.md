# aiployee-bridge — API Recon (authoritative)

**Date:** 2026-05-12
**Status:** Closed. Phase 1 (HTTP client) builds against this. Open
unknowns are flagged at the bottom and may be filled in during Phase 1
without re-running recon as a separate phase.

This document supersedes `00-summary.md` for endpoint shapes. The earlier
file is kept for the methodology (how the recon was performed) but the
shapes here are authoritative.

## Architecture

| Layer | Host | Tech | Purpose |
|-------|------|------|---------|
| Frontend | `https://aiployee.jobix.ai` | Yii2 (listing) + Angular + rete.js v8.2.14 (editor) | Full page reloads between sections (no SPA routing); injected JS dies on every navigation |
| API | `https://dashboard-api.jobix.ai/v1` | JSON over HTTPS, CORS-enabled for the frontend origin | The only host the bridge calls |

## Auth

Two methods both work; the bridge uses **bearer** because it's headless
and trivially serializable.

| Method | Header / property | Notes |
|--------|-------------------|-------|
| Bearer (used by bridge) | `Authorization: Bearer <access_token>` | The `access_token` is identical to the cookie of the same name on `aiployee.jobix.ai`. Verified against `/v1/flows/{uuid}/nodes`, `/v1/r/widgets-dropdown`, `/v1/r/phone-numbers-pool`, `/v1/flows/integrations-list`. |
| Session cookie | XHR with `withCredentials: true` and the `_identity` / `PHPSESSID` / `access_token` cookies | What the SPA itself uses. Cookies are scoped to `aiployee.jobix.ai`, so this only works from inside the page or from a backend that has captured them. |

**Bridge auth setup (one-time):** user opens
`https://aiployee.jobix.ai` in any logged-in browser, copies the
`access_token` cookie value, runs `aiployee-bridge auth --token <value>`.
Stored at `~/.aiployee-bridge/auth.json` with 0600 perms. The bridge
calls `GET /v1/r/widgets-dropdown` as a liveness probe on startup; on
401, prompts re-setup.

The `_identity` cookie has a 7-day TTL. Token rotation cadence is at
least that — bridge does not need to refresh proactively.

## Response envelope (universal)

Every response is wrapped:

```json
{
  "code": 200,
  "errors": null,
  "success": true,
  "result": <payload>
}
```

**Critical:** server-side validation failures return **HTTP 200** with
`success: false` and `errors` populated. The bridge MUST treat
`success === true` as the gate, not HTTP status. The UI toast "Cannot
save flow — some nodes contain errors" is the rendering of this field.

## Endpoint inventory

### Read

| Method | Path | When the SPA fires it | Returns |
|--------|------|------------------------|---------|
| GET | `/v1/flows` (presumed) | `/flows` listing page load | Flow list — **shape pending verification on Phase 1 first call** |
| GET | `/v1/flows/{uuid}/nodes` | Flow editor open | `Node[]` (see "Node shape" below) |
| GET | `/v1/flows/integrations-list` | Flow editor open | `{email:[], sms:[{value,label,status,description,numbers}], llm:[], custom:[]}` |
| GET | `/v1/r/phone-numbers-pool?type=inbound_call` | Inbound Call node edit | `[{label, value, ...}]` — used for the Inbound Call's phone-number picker |
| GET | `/v1/r/phone-numbers-pool?type=outbound_call` | Flow editor open | `[{agent_uuid, label, value}]` — numbers for outbound Call nodes; duplicates allowed (same number, different agent_uuid) |
| GET | `/v1/r/phone-numbers-pool?type=human_agent` | Flow editor open | `[{label, value}]` — transfer destinations (no `agent_uuid`) |
| GET | `/v1/r/agents-dropdown` | Agent picker opens | Agents for the Call / Connect Call Agent picker |
| GET | `/v1/r/widgets-dropdown` | Internet Call edit (and elsewhere) | `[{label, value}]` — actually the AI Agents list as labelled in the UI (e.g. "Agent 01 — Noa", "Agent 02 — Maya"). Coexists with `/agents-dropdown`; the two are not yet known to be identical. |
| GET | `/v1/r/actions-dropdown` | Actions picker opens | Available actions catalogue |

`/v1/r/*` is the consistent pattern for "reference" / dropdown lookups.
Other siblings are presumed (`events-dropdown`, `customer-fields`,
`voices-dropdown`, etc.) but not yet captured.

### Write

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/v1/nodes/save` | Save the full flow graph (body below). The only write path captured so far; full-replace, no per-node PATCH. |

## `POST /v1/nodes/save` — body shape

```jsonc
{
  "flow_uuid":        "b2deacdb-73d2-4b4e-b13a-b2de58dc7ebd",
  "flow_name":        "Architect test 1",
  "flow_description": "",
  "nodes": [ Node, Node, ... ]
}
```

Send the complete `nodes` array every time. The server replaces the
flow's graph wholesale.

## Node shape

```jsonc
{
  "uuid":       "2db7d1b8-1769-4bb7-b928-c0e7b14aa656",   // server-assigned on first save, stable across saves
  "name":       "FAQ Inbound",
  "type":       "inbound_call",        // internal name (snake_case); see type-mapping table below
  "status":     1,                      // 1 = enabled. 0 = disabled-but-kept (presumed; unobserved)
  "number":     18,                     // rete-assigned integer, used as the namespace for socket ids in THIS payload; NOT stable across saves
  "position":   [69.79, -4.92],         // array [x, y]
  "inputs":     [ Socket, ... ],
  "outputs":    [ Socket, ... ],
  "data":       { /* type-specific — see per-type table */ }
}
```

`Socket`:

```jsonc
{
  "id":   "ID_18_0",                   // inputs: "ID_<number>_<i>"; outputs: "OD_<number>_<i>"
  "name": null,
  "connections": [
    { "node_number": 21, "node_socket": "ID_21_0" }   // points at target node.number + target socket.id
  ]
}
```

### Load-bearing rules

- `uuid` is **stable across saves**. Round-trip it; don't generate.
- `number` is **NOT stable across saves**. The server (or rete) may
  renumber. The bridge must rebuild `connections` by looking up the
  target node by `uuid` (or `name` as fallback) at serialize time, not
  by remembering `number`. **Failure to do this corrupts the graph.**
- `data_key` is always `<type>_node_<number>`. The server may regenerate
  it; computing it client-side at serialize time is safer.
- Socket index semantics for `connect_call_agent` and `call`:
  - index 0 = **Completed**
  - index 1 = **Transfered** (misspelled by the platform on the wire — preserve the misspelling)
- The bridge's tool surface accepts both `"Transferred"` and `"Transfered"` on input; serialises `"Transfered"` on the wire.

### Type-name mapping (internal vs UI)

| Wire (`type`) | UI label |
|---------------|----------|
| `inbound_call` | Inbound Call |
| `internet_call` | Internet Call |
| `event` | Event |
| `now` | Now |
| `connect_call_agent` | Connect Call Agent |
| `call` | Call |
| `split` | Split |
| `delay` | Delay |
| `filter` | **Condition** (NOT "filter") |
| `update_data` | **Webhook** (NOT "Update Data") |
| `ai_data_generation` | **LLM** (NOT "AI Data Generation") |
| `sms` | SMS |
| `email` | Email |
| `api_request` | API Request |

The bridge ships a translation table; the wire always uses the internal
name.

### Per-type `data` blocks (observed)

```jsonc
// inbound_call
{
  "data_key": "inbound_call_node_<n>",
  "phone_numbers": ["+27877295318"],
  "cancel_prev_executing": false,
  "google_sheets_sync_data": {
    "use_google_sync": false,
    "google_sheet_id": null,
    "google_sheet_name": null
  }
}

// connect_call_agent
{
  "data_key": "connect_call_agent_node_<n>",
  "actions": [],
  "connect_agent_params": {
    "copy": false,                     // true after "Copy agent and bind to this node"
    "type": "ai",                       // "ai" | "real"
    "uuid": "<agent-uuid>",
    "prompt": null,                     // node-level override; null = use the agent's global prompt
    "phone_numbers": []
  }
}

// call
{
  "data_key": "call_node_<n>",
  "actions": [],
  "max_concurrent_executing": null,
  "retry_policy": { "is_active": false, "rules": [] },
  "agent_params": {
    "copy": false,
    "uuid": "<agent-uuid>",
    "prompt": null,
    "phone_numbers": []
  }
}
```

Other types (`event`, `now`, `internet_call`, `split`, `delay`,
`filter`, `update_data`, `sms`, `email`, `api_request`,
`ai_data_generation`) need one save each to capture. **Phase 1 strategy:**
build the client and schema scaffolding around the three known shapes;
add the remaining types as they are encountered, using `z.unknown()` as
a permissive fallback for the type-specific block until each is pinned.

## Phone-number normalisation

- UI accepts `0877295318`, stores `+27877295318`. The wire always carries
  the E.164 form.
- Autocomplete offers `[telico] - +27877292937` (a similar but distinct
  number). The bridge MUST NOT auto-select on partial match; surface the
  full list and require an exact pick.
- The pool endpoint hides numbers already assigned to another active
  flow. `list_phone_numbers` in the bridge's tool surface MUST include
  the assignment, not just the number — otherwise the LLM picks a
  number the API will reject.

## Prompt templating

`prompt` fields use `{{ ... }}` referencing other nodes by `data_key`,
e.g. `{{ connect_call_agent_node_59.transcription }}` or
`{{ attributes.number }}`. The bridge passes prompts through verbatim.
Documenting the available attributes per node type is a non-goal for
Phase 1 (the LLM caller can read existing flows for examples).

## Behavioural notes

- Failed save does NOT roll back the in-memory rete graph. The browser
  still shows the attempted nodes; a hard reload reveals the server kept
  only the previous good state. The bridge MUST re-fetch
  (`GET /v1/flows/{uuid}/nodes`) after any failed save before exposing
  state to the caller.
- Material dialogs are singleton; UI quirk only.
- Connect Call Agent's "Agent Type" (ai/real) and "Agent" dropdowns are
  a two-step in the UI but a single object on the wire — `type` plus
  `uuid` inside `connect_agent_params`.

## Sandbox entities (recon-only — bridge users see whatever their tenant has)

| Kind | Name | UUID |
|------|------|------|
| Flow | `Architect test 1` | `b2deacdb-73d2-4b4e-b13a-b2de58dc7ebd` |
| Agent | `Tracey Restuarant booking(Test)` | `3527076a-e3d2-4eb5-bfdb-498e02cde84f` |
| Phone | (display) `0877295318` → (wire) `+27877295318` | — |

These are the only entities touched during recon. Production agents,
numbers, and other flows were not bound, mutated, or activated.

## XHR interceptor (recon tool, not bridge code)

Install once per page; dies on every navigation because the SPA does
full page loads:

```js
window.__recon = { entries: [] };
const oo = XMLHttpRequest.prototype.open;
const os = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(m, u) {
  this.__url = u; this.__method = m;
  return oo.apply(this, arguments);
};
XMLHttpRequest.prototype.send = function(b) {
  this.addEventListener('load', () => {
    let r = this.responseText;
    try { r = JSON.parse(r); } catch (e) {}
    window.__recon.entries.push({
      url: this.__url, method: this.__method, status: this.status,
      reqBody: typeof b === 'string' ? b : null, body: r
    });
  });
  return os.apply(this, arguments);
};
```

`performance.getEntriesByType('resource')` is the fallback when the
recorder missed something — gives URLs but not bodies; use it to know
what to re-trigger.

## Open unknowns (filled during Phase 1 first call, not as separate recon)

| Unknown | How Phase 1 fills it |
|---------|----------------------|
| `list_flows` endpoint (presumed `GET /v1/flows`) | Bridge calls it on first `list_flows` invocation; on 404, falls back to scraping the Yii-rendered `/flows` HTML and surfaces the discrepancy in logs. |
| `create_flow` endpoint | Bridge attempts `POST /v1/flows` with `{ name, description? }`; on 404 or 422, the schema/result shape becomes the recon. |
| `delete_flow` endpoint | Bridge attempts `DELETE /v1/flows/<uuid>`; same fallback. |
| `set_flow_status` endpoint | Likely `POST /v1/flows/<uuid>/status` body `{ status: "Active" }`. Bridge attempts; on failure surfaces full error envelope. |
| `/v1/r/events-dropdown`, `customer-fields`, `voices-dropdown` | Discovered as bridge tools that need them are written. |
| 11 remaining per-type `data` blocks | Each one is one `get_flow` call against a real flow that uses that node type. |

The bridge ships these as tool calls now; their first invocation against
a live tenant fills the spec. This is the cheapest path to a working
bridge — `list_flows` and `create_flow` are not load-bearing for the
existing-flow use cases that Phase 1 enables, and they can be hardened
once we see real responses.
