# Phase 0 — Reconnaissance

Goal: capture enough of AIployee's wire format that `src/client/` can be
written without guessing. **No code in `src/` is written until this phase
is done and committed.**

## Method

Use the browser DevTools Network panel against your already-logged-in
session at `https://aiployee.jobix.ai/flows`. No automation needed.

1. Open DevTools → Network. Tick "Preserve log". Set filter to `Fetch/XHR`.
2. For each scenario below, clear the panel, perform the action, then
   right-click → **Save all as HAR with content** to `recon/har/<scenario>.har`.
3. After each HAR, write a short note in `recon/notes/<scenario>.md` with:
   - Method + path
   - Auth header shape (redact the actual token, just note the format)
   - Request body shape
   - Response body shape (truncated to one example item if a list)
   - Anything surprising

## Scenarios to capture (in order)

| # | Scenario | File | Purpose |
|---|----------|------|---------|
| 1 | Page load on `/flows` | `01-list-flows.har` | `list_flows` endpoint, auth header shape |
| 2 | Click into one flow | `02-get-flow.har` | `get_flow` endpoint, full Flow payload shape |
| 3 | Create new empty flow | `03-create-flow.har` | `create_flow` payload + response |
| 4 | Rename a flow | `04-rename-flow.har` | does update use full-PUT or PATCH? |
| 5 | Add an Inbound Call node, save | `05-add-inbound-call.har` | per-node save endpoint(s), Flow PUT vs node POST |
| 6 | Add Connect Call Agent node, save | `06-add-connect-agent.har` | agent picker → bind to node |
| 7 | Add Split node with 60/40 outputs, save | `07-add-split.har` | percentage field name + validation |
| 8 | Add Email node, save (try both Visual and HTML builders) | `08-add-email.har` | `builderType` value + body field |
| 9 | "Copy agent and bind to this node" on Connect Call Agent | `09-copy-agent.har` | the per-node clone endpoint |
| 10 | Save a flow with deliberately invalid Inbound Call (empty number list) | `10-validate-empty-number.har` | server validation error shape |
| 11 | Save with typed-but-unassigned phone number | `11-validate-unassigned.har` | distinguish from #10 |
| 12 | Save with unconfigured Connect Call Agent | `12-validate-no-agent.har` | distinguish again |
| 13 | Toggle a flow Active | `13-activate.har` | `set_flow_status` endpoint |
| 14 | Toggle the same flow Inactive | `14-deactivate.har` | confirm symmetric |
| 15 | Try to activate Flow B that uses Flow A's inbound number | `15-activate-collision.har` | does it fail or steal? **document the verdict** |
| 16 | Delete a flow | `16-delete-flow.har` | DELETE endpoint shape |
| 17 | Open agents list (wherever it lives in the app) | `17-list-agents.har` | full agent payload incl. voice/language/active |
| 18 | Open phone numbers list / settings | `18-list-numbers.har` | **must include assignment field** |
| 19 | Any other named entity the flow editor binds to (groups, prompts, etc.) | `19-list-<entity>.har` per entity | full discovery surface |

## Output

When all 19 are captured and noted, commit as:

```
git add recon/
git commit -m "phase 0: recon — HARs and notes for AIployee flow editor API"
```

Only then does Phase 1 begin.

## Redaction

HAR files are gitignored by default because they contain bearer tokens
and PII. If you want any specific request committed for the record,
sanitise it into a markdown snippet in `recon/notes/` first.
