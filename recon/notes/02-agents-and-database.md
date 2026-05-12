# aiployee-bridge — Recon 02: Agents + Custom Fields (Database)

**Date:** 2026-05-12
**Status:** Initial pass. Read-only. No mutations.
**Builds on:** `01-api.md` (the Flows API).

This recon extends the bridge's scope from Flows to a unified "AIployee
MCP Bridge" covering three surfaces: Flows, Agents, and Custom Fields
(the "database" where hydratable variables live).

## Surface map

The AIployee app exposes three classes of write surface that the bridge
needs to handle differently:

| Surface | Host | Tech | Update mode |
|---|---|---|---|
| **Flows** | `dashboard-api.jobix.ai/v1/*` | JSON API | `POST /v1/nodes/save` with bearer auth (already in v0.1.0) |
| **Agents** | `aiployee.jobix.ai/ai-agent/*` | Yii ActiveForm | Form POST (urlencoded, multipart for files) with `_csrf` cookie + `_submission_token` |
| **Custom Fields** | `aiployee.jobix.ai/management/customer-fields` | Yii ActiveForm | Bulk form POST for the whole field list |

A single bearer token (the `access_token` cookie value) is sufficient
for the dashboard-api side. The Yii side uses the Yii session cookies
(`PHPSESSID`, `_identity`, `_csrf`); the bridge needs all three to talk
to that host, NOT just the bearer.

**Implication for `aiployee-bridge auth`:** the auth file needs to
store a `cookieJar` (3 cookies) in addition to the `accessToken`. The
one-time setup grows by two cookie copies (still trivial).

## Agents — page and form shape

### URLs

- List: `GET /agents` (Yii server-rendered)
- Create form: `GET /ai-agent/create`
- Edit form: `GET /ai-agent/<uuid>/edit`
- Submit (both create and edit): `POST /ai-agent/<uuid>/edit` with the form below
- List edit links via the listing page: `<a href="/ai-agent/<uuid>/edit">` rows

### Form structure (`AiAgentForm`)

177 named fields total. The ones that matter for a prompt-as-OS
architecture, with observed types and example values from the Tracey
(Test) agent (`3527076a-e3d2-4eb5-bfdb-498e02cde84f`):

| Field | Form type | Wire shape | Example |
|---|---|---|---|
| `AiAgentForm[uuid]` | hidden | UUID | `3527076a-...` |
| `AiAgentForm[name]` | text | string | `Tracey Restuarant booking(Test)` |
| `AiAgentForm[main_goal]` | textarea | string | `INBOUND CUSTOMER SERVICE AND BOOKINGS AGENT.` |
| `AiAgentForm[prompts]` | **textarea** | **freeform multi-line; this is THE master prompt** | `## IDENTITY\n\nYou are Ellie, reservations host at L'Elixer...` (3374 chars) |
| `AiAgentForm[opening_greeting]` | textarea | string | (empty by default) |
| `AiAgentForm[summary_prompt]` | textarea | string, gated by `[is_summary_prompt]` checkbox | post-call summary instructions |
| `AiAgentForm[debug_prompt]` | textarea | string, gated by `[is_debug_prompt]` checkbox | per-turn debug analysis instructions |
| `AiAgentForm[phone_numbers]` | hidden | JSON string: `[\"+27877295318\"]` | E.164 array |
| `AiAgentForm[knowledge_websites]` | hidden | JSON string: `[{"url":"..."}]` | RAG URL list |
| `AiAgentForm[knowledge_text]` | hidden | string | inline RAG text |
| `AiAgentForm[knowledge_files][]` | hidden + file | upload (multipart) | knowledge documents |
| `AiAgentForm[policies]` | hidden | JSON string | policies array |
| `AiAgentForm[actions]` | hidden | JSON string: `[]` | bound actions |
| `AiAgentForm[voice_id]` | hidden | UUID | `eebf9e20-9660-40c0-8e53-a923041697ed` |
| `AiAgentForm[language_ai_selection]` | hidden | language code | `en` |
| `AiAgentForm[stt_provider]` | select-one | enum string | `sttv2` |
| `AiAgentForm[behavior_style]` | hidden | int id | `1` |
| `AiAgentForm[creativity_level]` | hidden | int id | `10` |
| `AiAgentForm[response_length]` | hidden | int id | `3` |
| `AiAgentForm[call_limitation]` | hidden | int id | `13` |
| `AiAgentForm[business_context]` | hidden | int id | `11` |
| `AiAgentForm[primary_use_case]` | hidden | int id | `4` |
| `AiAgentForm[draft]` | hidden | bool flag | empty |
| `_submission_token` | hidden | per-render token | `token_1778576897956_1g67ljk` |

Plus `_csrf` cookie in the request headers (Yii standard).

The integer id fields (`behavior_style`, `creativity_level`,
`response_length`, `call_limitation`, `business_context`,
`primary_use_case`) need a separate recon pass each to discover the
enum mapping (id → human label). For Phase 6 the bridge can treat them
as opaque ints that the LLM caller must pass through unchanged — the
"set the prompt" workflow doesn't need to understand them.

### Bridge `update_agent` implementation strategy

1. `GET /ai-agent/<uuid>/edit` → parse the HTML form. Extract every
   currently-set field value PLUS `_submission_token` PLUS the `_csrf`
   header value (in `<meta name="csrf-token">`).
2. Caller passes a partial update (e.g. just `prompts` and `name`).
   Bridge merges over the parsed full state.
3. `POST /ai-agent/<uuid>/edit` with `application/x-www-form-urlencoded`
   (or `multipart/form-data` if any file fields are present), Yii
   session cookies, and `X-CSRF-Token` header. Body is the merged
   `AiAgentForm[...]` fields.
4. Response is a 302 redirect on success, or the same page with
   `.has-error` divs on failure. Bridge parses errors out of the HTML.

This is more involved than a clean JSON API. It's deterministic.

## Custom Fields — page and form shape

### URLs

- List + edit: `GET /management/customer-fields`
- Bulk submit: `POST /management/customer-fields`

### Form structure (`UpdateOrCreateCustomerFieldForm`)

A single bulk-edit form. 54 fields exist in this tenant. Per-row shape:

```
UpdateOrCreateCustomerFieldForm[fields][<i>][uuid]         hidden  UUID
UpdateOrCreateCustomerFieldForm[fields][<i>][name]         text    display name
UpdateOrCreateCustomerFieldForm[fields][<i>][type]         text    data type — observed: "string" (likely also number/bool/date/json)
UpdateOrCreateCustomerFieldForm[fields][<i>][slug]         text    template key used in `{{ variables.<slug> }}`
UpdateOrCreateCustomerFieldForm[fields][<i>][description]  text    free-text description
```

Example: field index `1` in the demo tenant — `{uuid: "35bd6ca6-...",
name: "call", type: "string", slug: "call", description: ""}`.

The `slug` field is load-bearing: that's the variable name the
templating engine resolves at call time (e.g. `{{ variables.call }}` in
a prompt becomes the value of the customer record's `call` field).

Total form field count is ~379 (5 fields × 54 rows + overhead), so the
submit body is moderately large but trivial for a Node HTTP client.

### Add / remove rows

The page has an "Add field" button (presumed JS that appends another
`[fields][N]` row); rows with no uuid become inserts on submit, rows
deleted from the form become deletes. The wire convention for this
needs one observation to pin down — but the bulk form pattern is
standard Yii.

### Bridge `set_custom_field` strategy

Two flavors:

- `set_custom_field(slug, {name?, type?, description?})` — single-field
  upsert. Implementation: GET the page, modify or append one row,
  re-POST the full form.
- `list_custom_fields()` — GET the page, extract one DTO per row.

A finer-grained API doesn't exist on this surface (the page submits
everything at once), so the bridge has to do read-modify-write on the
entire form for every change. Acceptable: writes are rare; reads can
be cached for the session.

## What this enables for the user's "prompt OS" architecture

The state-driven prompt design needs three primitives:

1. **Read/write the master agent prompt** — covered by Agent CRUD.
2. **Define variable schema** (the "database" — `detected_intent`,
   `active_skill`, `active_skill_prompt` etc.) — covered by Custom
   Fields CRUD.
3. **Inject variables into prompts at call time** — the templating
   engine `{{ variables.<slug> }}` already exists. We've seen it work
   for node-output variables (`{{ connect_call_agent_node_59.transcription }}`);
   the platform almost certainly resolves `{{ variables.<slug> }}` from
   the same Custom-Fields-backed namespace, but **this needs one
   verification** — see "Open questions" below.

The user's exact design:

```
detected_intent          → custom field, type string
active_skill             → custom field, type string
active_skill_prompt      → custom field, type text (multi-line)
current_state            → custom field, type string
known_fields             → custom field, type json
missing_fields           → custom field, type json (array)
next_best_action         → custom field, type string
routing_confidence       → custom field, type float
caller_tone              → custom field, type string
audio_quality            → custom field, type string
party_size               → custom field, type number
availability_status      → custom field, type string
escalation_required      → custom field, type bool
```

The bridge ships `create_custom_fields_bulk(specs[])` and the user
defines this whole schema in one tool call. Then the master prompt
references `{{ variables.detected_intent }}` etc. and the templating
engine does the rest. **The remaining design question is how the
values get written during a call** — that's the "Open questions"
section below.

## Per-call ephemeral state vs. persistent customer state

This is the most important question still open. The Custom Fields
surface is almost certainly **per-Contact persistent storage**, meaning
values set during one call survive to the next call. The user's
"detected_intent / active_skill / current_state / next_best_action"
variables are **per-call ephemeral state** that probably shouldn't
persist.

Three places the per-call state could live:

| Option | Where | Cost |
|---|---|---|
| A. On the Contact, overwritten every call | Custom Fields | Cheap. Leaks last-call state into next call until next intent classification fires. Acceptable if `detected_intent` etc. are written every turn. |
| B. On a Conversation / Call entity | `/calls` page (unrecon'd) | Cleanest semantically. Needs Phase 6.5 recon. |
| C. As node-output variables flowing through the flow | Already works via `{{ <node_data_key>.<field> }}` | Confined to one flow execution. Doesn't survive a node-to-node Connect-Call-Agent handoff cleanly. |

For an MVP, **option A is sufficient**: per-call variables are written
to Custom Fields each turn by a Webhook node, the next turn reads them
back. The bridge can support all three patterns without picking one.

## Other endpoints spotted (not yet decoded)

From inline scripts on the agent edit page, the following dashboard-api
endpoints exist but weren't captured:

- `/v1/gemini/...` — Gemini API integration (multiple references)
- `/v1/charges` — billing / usage metering
- `/v1/action/...` — Actions CRUD (Tools sidebar item at `/actions`)
- `/v1/temporary-agent-widget` — sandbox widget for testing prompts

`/v1/action/*` is worth a Phase 7 follow-up — Actions are bound to
agents and represent the "tools" an agent can call. State-driven
prompts often want to enable/disable specific actions per skill
("during BOOKING skill, the only enabled action is `check_availability`").

## Out of scope for this recon

- **Voice catalogue** (`/ai-voices`) — needed only if the bridge
  exposes voice selection in `update_agent`. Defer.
- **Conversations / Call records** (`/calls`) — per-call state if we
  pick option B above. Defer until option B becomes necessary.
- **Contacts** (`/customers`) — the records themselves. Needed for
  bridge tools that read/write a specific customer's Custom Field
  values. Defer to Phase 6.5.
- **Automation V2** (`/automation`) — newer workflow system. Different
  product? Different version? Worth one read-only check, but defer.
- **Actions** (`/actions` + `/v1/action/*`) — Phase 7.
- **Phone Numbers** (`/phone-numbers`) — already partly covered via
  `/v1/r/phone-numbers-pool`. Defer.
- **Widgets** (`/widgets`) — defer.

## Open questions to verify in one follow-up recon hop

1. **Does `{{ variables.<slug> }}` in an agent prompt resolve from the
   Custom Fields namespace?** (Confirm by setting one custom field on
   the Tracey test agent's Contact, referencing it in the prompt, and
   observing — but this needs a write, so defer to Phase 6 build.)
2. **Is the `type` field on a Custom Field constrained to a known
   enum?** (Try `number`, `boolean`, `json`, `date` and see which the
   form accepts.) — pin down at Phase 6 build time.
3. **Bulk-form delete convention.** (How does removing a row from the
   form get interpreted by the server?) — pin down at Phase 6 build time.
4. **Per-call state pattern.** (See "Per-call ephemeral state" section
   above.) — design decision, not a recon question.

None of these block writing Phase 6 — the bridge can ship `update_agent`
+ `list_custom_fields` + `upsert_custom_field` against the form shape
we already have, with the unknowns surfaced as caller-facing errors
on first encounter (same fail-loud strategy as `01-api.md`).
