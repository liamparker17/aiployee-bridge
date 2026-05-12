# Phase 0 — Recon Summary

**Captured:** 2026-05-12, against the live tenant
`https://aiployee.jobix.ai` (account: `liam+aiployee-demo@aiployee.co.za`).
All findings below were observed in actual network traffic and replayed
successfully, not inferred.

## Headlines

1. **Frontend is two stacks.**
   - `/flows` listing page is **Yii2 + jQuery** (server-rendered).
   - `/flows/<uuid>` editor is **Angular Material** (mat-* classes,
     `ng-star-inserted`). The earlier spec's assumption of "React +
     Material UI" was wrong.
2. **The bridge only needs one host.** All flow data ops go to a
   separate API host:
   ```
   API_BASE = https://dashboard-api.jobix.ai/v1
   ```
   `aiployee.jobix.ai` is only the Yii frontend that bootstraps an auth
   token into the editor SPA. The bridge does not need to talk to it
   except to scrape the listing page (which is server-rendered HTML, not
   API).
3. **Auth is simple bearer.**
   ```
   Authorization: Bearer <access_token>
   ```
   The `access_token` is also set as a `localhost`-readable cookie on
   `aiployee.jobix.ai`:
   ```
   access_token=KwjBPD8fdMburLFD9t_YSSfv  (60 chars, rotates per session)
   ```
   The SPA reads it from an inline `<script>` on the editor page:
   ```html
   <script>
     const apiHost = 'https://dashboard-api.jobix.ai';
     const _authToken = 'KwjBPD8fdMburLFD9t_YSSfv';
   </script>
   ```
   No CSRF, no signature, no nonce. The token cookie is `httpOnly: false`
   and `secure: false`, so it's readable from JS on that origin.

4. **All responses use a JSend-style envelope.**
   ```json
   { "success": true, "code": 200, "result": <payload>, "errors": null }
   ```

## Confirmed endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET    | `/v1/flows/{uuid}/nodes` | Read a flow's node graph |
| POST   | `/v1/nodes/save` | Save flow + nodes (body below) |
| GET    | `/v1/flows/integrations-list` | Integrations grouped by `{email, sms, llm, custom}` |
| GET    | `/v1/r/phone-numbers-pool?type=outbound_call` | Numbers usable for outbound; includes owning `agent_uuid` |
| GET    | `/v1/r/phone-numbers-pool?type=human_agent` | Numbers usable as transfer destinations (no `agent_uuid`) |
| GET    | `/v1/r/widgets-dropdown` | **AI Agents list** (labels are "Agent 01 — Noa", etc; despite the name) |

## Save endpoint (`POST /v1/nodes/save`)

Request body — flat, not nested:
```json
{
  "flow_uuid": "b2deacdb-73d2-4b4e-b13a-b2de58dc7ebd",
  "flow_name": "Architect test 1",
  "flow_description": "",
  "nodes": [ Node, Node, ... ]
}
```

Response: `{"success":true,"code":200,"result":[],"errors":null}` on success.

## Node shape (verified from `/v1/flows/231e444a-.../nodes`)

```jsonc
{
  "uuid": "3f2a5423-1dc9-4018-8dd9-b7d04618adb6",
  "name": "Pace Siya",
  "type": "connect_call_agent",   // lowercase snake_case, NOT "Connect Call Agent"
  "status": 1,                     // 1 = active, 0 = inactive
  "number": 66,                    // monotonic per-node sequence; drives socket ids
  "position": [580.07, 522.49],    // array [x,y], NOT { "x": .., "y": .. }
  "inputs": [
    {
      "id": "ID_66_0",             // pattern: "ID_<number>_<i>"
      "name": null,
      "connections": [
        { "node_number": 59, "node_socket": "OD_59_1" }
      ]
    }
  ],
  "outputs": [
    {
      "id": "OD_66_0",             // pattern: "OD_<number>_<i>"
      "name": null,
      "connections": []
    },
    { "id": "OD_66_1", "name": null, "connections": [] }
  ],
  "data": {
    "actions": [],
    "data_key": "connect_call_agent_node_66",   // pattern: "<type>_node_<number>"
    // type-specific subobject (see node-type table below)
    "connect_agent_params": {
      "copy": false,
      "type": "ai",
      "uuid": "11866e5a-70d2-4e6f-894b-583d8a32af13",
      "prompt": "{{ connect_call_agent_node_59.transcription }}\n\n{{ attributes.number }}",
      "phone_numbers": []
    }
  },
  "updated_at": 1777971344,
  "created_at": 1777971344
}
```

## Node `type` values seen so far

| `type` (wire) | UI label | Type-specific `data` field |
|---------------|----------|----------------------------|
| `call` | "Call" (outbound) | `agent_params: {copy, uuid, prompt, phone_numbers[]}` + `retry_policy` |
| `connect_call_agent` | "Connect Call Agent" | `connect_agent_params: {copy, type:"ai", uuid, prompt, phone_numbers[]}` |

Remaining types listed in the editor sidebar (still to capture
payloads for): `Event`, `Now`, `Inbound Call`, `Internet Call`, `Split`,
`Delay`, `Condition`, `Webhook`, `Email`.

## Socket-id convention (load-bearing for the bridge)

- Input `id = "ID_" + node.number + "_" + i`
- Output `id = "OD_" + node.number + "_" + i`
- `connections[].node_socket` references the **target** socket id
  literally; `connections[].node_number` is the target's `number`.

The bridge can generate these deterministically. The local validator's
"socket exists" rule reduces to: every `{node_number, node_socket}` pair
in any connection points at a node `number` and a socket `id` that both
exist in the request.

## Templating

`prompt` fields use a `{{ ... }}` template syntax that references
**other nodes by data_key**, e.g.
`{{ connect_call_agent_node_59.transcription }}`. The bridge does not
need to interpret these — pass through verbatim — but `list_agents`
output should document the available attributes so the LLM picks valid
references.

## Phone-numbers pool

Two flavors, both `GET /v1/r/phone-numbers-pool?type=<type>`:

| `type` | Shape | Notes |
|--------|-------|-------|
| `outbound_call` | `[{agent_uuid, label, value}]` | `value` is the E.164 number; the SAME number can appear multiple times, each tied to a different `agent_uuid`. |
| `human_agent` | `[{label, value}]` | No `agent_uuid` — these are pure transfer destinations. |

The bridge's `list_phone_numbers` tool MUST split these into two lists or
include the `kind` field, because they serve different purposes.

## Agents list

`GET /v1/r/widgets-dropdown` returns:
```json
[
  {"label": "Alex Website Widget", "value": "85823dc8-5dad-447a-962c-41504c2d0ff6"},
  {"label": "Agent 01 — Noa | Residential Sales Qualifier", "value": "54d4040b-..."},
  ...
]
```

`value` is the agent UUID — exactly what goes into
`data.connect_agent_params.uuid`. The original spec mentions richer agent
metadata (voice, language, active, description); this endpoint does not
return those. There must be another endpoint (`/v1/agents` or similar)
that does. **Still to recon.**

## Auth bootstrapping (for the `aiployee-bridge auth` CLI)

Setup flow:

1. User opens `https://aiployee.jobix.ai` in any logged-in browser.
2. Opens DevTools → Application → Cookies → copies the `access_token`
   cookie value.
3. Runs `aiployee-bridge auth --token <value>`. Bridge stores at
   `~/.aiployee-bridge/auth.json` (0600).
4. Bridge calls `GET /v1/r/widgets-dropdown` as a liveness check on
   startup; if 401, prompts the user to re-run setup.

No automation, no scraping, no `curl-impersonate` needed. Tokens last at
least 7 days (the `_identity` cookie has a 604800s = 7-day TTL).

## Still to recon (write-side)

These require driving UI actions in the editor and were not captured in
this session. Each is a 1-action recon: install the recorder via
`evaluate`, click the corresponding UI button, dump entries.

| What | UI action to trigger it |
|------|-------------------------|
| `create_flow` endpoint | Click "+ New Flow" on `/flows` |
| `delete_flow` endpoint | Click delete (trash icon) on a flow row |
| `set_flow_status` (Active/Inactive) | Toggle the Active switch on the editor |
| Server validation error envelope | Save a flow with an unconfigured Connect Call Agent |
| Agent details endpoint (voice/language/etc) | Open the AI Agents page in the sidebar |
| Per-type node payloads (`Inbound Call`, `Split`, `Email`, `Webhook`, `Delay`, `Condition`, `Event`, `Now`) | Add each node type in the editor, save, GET `/v1/flows/<uuid>/nodes` |

## Open questions for the user / next session

1. **`update_flow` is full-replace.** `POST /v1/nodes/save` accepts the
   complete `nodes[]` array — there is no per-node PATCH. That matches
   the spec's `update_flow(uuid, flow_json)` semantics; we don't need
   per-node mutations. Confirmed.

2. **Cross-flow phone collision behaviour** still unknown. The activate
   endpoint isn't recon'd yet; can't test until then.

3. **`number` allocation.** New nodes get a monotonic `number` somehow.
   Either the server assigns on save, or the client picks `max(number)+1`.
   To confirm, save a new node and watch what the body sends vs. what
   the GET returns. The bridge should probably let the server assign and
   re-read.

## Trust level

Everything in this document was observed in real wire traffic, then
**replayed end-to-end with the bridge's intended auth** (`Authorization:
Bearer <token>`). The bridge can start Phase 1 (`src/client/`) against
this surface confidently.
