# aiployee-bridge — Recon 03: Templating, Write Paths, Node Palette

**Date:** 2026-05-12
**Status:** Read-only. No mutations.
**Supersedes** `02-agents-and-database.md` on three specific points
(noted inline below). Otherwise extends 02.

This recon pass answered the load-bearing question for the "prompt OS"
architecture: **how does mid-call and post-call state actually flow
between the LLM, Custom Fields, and Contact records?**

## Three corrections to `02-agents-and-database.md`

### 1. Templating namespace is `attributes`, not `variables`

`02-agents-and-database.md` referred to `{{ variables.<slug> }}`. The
platform's templating namespace for Custom Fields is **`attributes`**,
not `variables`.

Evidence: the agent edit page contains an inline JS array (used to
power a picker dropdown on prompt fields, Webhook bodies, and API
Request parameters):

```js
let variables = [
  { id: 7845189,  slug: "_do_not_contact",     label: "Do not contact",  anchor: "{{ attributes._do_not_contact }}" },
  { id: 7845190,  slug: "_do_not_message",     label: "Do not message",  anchor: "{{ attributes._do_not_message }}" },
  { id: 19938678, slug: "active_ptp_due_date", label: null,              anchor: "{{ attributes.active_ptp_due_date }}" },
  // ... 51 more entries matching the 54 Custom Fields in the demo tenant
];
```

The JS variable is named `variables` (it's the dropdown source). The
template anchor it inserts is `{{ attributes.<slug> }}`. The bridge
must use the anchor form on the wire.

### 2. There is no built-in "write attribute" flow node

The full node palette is exactly 14 types — Triggers ×4, Operators ×3,
Actions ×7:

| Group | Wire `type` | UI label |
|-------|-------------|----------|
| Trigger | `event` | Event |
| Trigger | `now` | Now |
| Trigger | `inbound_call` | Inbound Call |
| Trigger | `internet_call` | Internet Call |
| Operator | `split` | Split |
| Operator | `delay` | Delay |
| Operator | `filter` | **Condition** |
| Action | `update_data` | **Webhook** — outbound HTTP POST. Does NOT write contact attributes. |
| Action | `call` | Call |
| Action | `connect_call_agent` | Connect Call Agent |
| Action | `sms` | SMS |
| Action | `email` | Email |
| Action | `api_request` | API Request |
| Action | `ai_data_generation` | **LLM** — generic LLM call with named outputs |

The previous recon doc speculated that "the bridge ships Webhook nodes
that persist state to Custom Fields". That was wrong. **Webhook
(`update_data`) is an outbound HTTP POST.** Its `data.webhook` config
is `{ url, method, status, headers, payload, content_type }` and its
job is to send a request to an external URL — its `payload` field
templates from `{{ attributes.X }}` but it does not write back.

### 3. Custom Field `type` enum is verified, no `json`/`text`

`02-agents-and-database.md` mentioned "json" and "text" as possible
types. The actual enum from the type dropdown:

```
date, float, array, string, integer, boolean
```

Long-form text uses `string`. List-typed fields use `array`. There is
a hard cap of **225 Custom Fields per tenant**.

## How state actually flows (the answer to "is this architecture workable")

There are exactly four state-handling primitives in the platform. The
"prompt OS" design works by composing them — not by inventing new
state mechanisms.

### Primitive 1: `{{ attributes.<slug> }}` — read at prompt-eval time

Every Custom Field is readable in any prompt or templated field via
`{{ attributes.<slug> }}`. The resolution happens at the moment the
agent's prompt is sent to the LLM (so each turn re-reads).

Surfaces where this templating fires:
- Agent master prompt (`AiAgentForm[prompts]`)
- Agent summary prompt (`AiAgentForm[summary_prompt]`)
- Per-node prompts on Connect Call Agent / Call nodes (the
  `prompt` field inside `data.connect_agent_params` /
  `data.agent_params`)
- Webhook `data.webhook.payload`
- API Request body/headers (`api_request` node)

### Primitive 2: Per-Contact write — `POST /customers/<uuid>/edit`

The Contact edit form is `SaveCustomerForm`. The Custom Field values
namespace is `SaveCustomerForm[values][<slug>]`. So:

```
POST /customers/<uuid>/edit
Content-Type: application/x-www-form-urlencoded
Cookie: PHPSESSID=...; _identity=...; _csrf=...; access_token=...
X-CSRF-Token: <meta csrf>

SaveCustomerForm%5Bphone%5D=%2B27...
SaveCustomerForm%5Bvalues%5D%5Bdetected_intent%5D=booking
SaveCustomerForm%5Bvalues%5D%5Bactive_skill%5D=booking
_submission_token=<token>
```

Field types in the form match the Custom Fields enum:
- `text` for `string`
- `number` for `integer` / `float`
- `select-one` for `boolean` and any enum-typed field

This is what enables **mid-call writes** to attributes. The bridge
exposes it as `update_contact_attribute({contactUuid, slug, value})`.
An `api_request` flow node can ALSO call this URL during a call to do
the same thing from within the flow graph — but routing through the
bridge tool is the cleaner path.

### Primitive 3: Post-call extraction via `summary_prompt`

Each agent has an `is_summary_prompt` toggle and a `summary_prompt`
textarea. After the call ends, the platform runs the LLM with the
transcript + the `summary_prompt` and **persists the extracted fields
to the Contact's `values.<slug>`**.

Example default `summary_prompt` on a real agent: "Analyze this call
transcript and extract: 1. Customer intent and sentiment throughout
the conversation, 2. Key discussion points..."

This is the cheapest path for persisting per-call state. No mid-call
infrastructure needed. Drawback: extraction runs once at end-of-call,
not between turns — so any decision the next turn needs based on the
extraction has to be re-derived from the conversation history (which
the LLM has anyway).

### Primitive 4: Node-output variables — `{{ <node_data_key>.<field> }}`

Within a single flow execution, every node's output is referenceable
by its `data_key`. We saw this in the wild: a Connect Call Agent node
referencing the transcription of a previous Connect Call Agent node
via `{{ connect_call_agent_node_59.transcription }}`.

The `ai_data_generation` (LLM) node is the most interesting consumer
of this: it can take input from previous nodes, run a prompt, and emit
named outputs that subsequent nodes read. This is the **mid-call
classifier** node for state-driven routing.

## The "prompt OS" architecture, expressed in platform primitives

Map of the user's design onto what the platform actually supports:

| User's variable | Where it lives | Read in prompt as | Written by |
|-----------------|----------------|-------------------|------------|
| `customer_name`, `email`, `phone`, booking history, etc. | Contact record | `{{ attributes.<slug> }}` | bridge `update_contact_attribute`, or `api_request` node, or post-call `summary_prompt` |
| `detected_intent`, `active_skill` (per-call but you want them to survive a Connect-Call-Agent handoff) | Same — write to Contact, overwrite each call | `{{ attributes.detected_intent }}` etc. | An LLM classifier node early in the flow → API Request node to update the attribute → fan-out via Split node based on the value |
| `caller_tone`, `audio_quality`, `next_best_action` (per-turn ephemeral) | LLM conversation context (implicit) | The agent re-derives each turn from the running transcript | Not externalised; the prompt tells the agent how to read these from the conversation |
| `known_fields`, `missing_fields` for a booking-in-progress | LLM conversation context, OR Contact `values.last_booking_known_fields` (an array Custom Field) if you want it to survive a handoff between skill nodes | `{{ attributes.last_booking_known_fields }}` if persisted | Updated via `update_contact_attribute` after each turn that learns something new, OR left in conversation context |
| `active_skill_prompt` content | Per-node prompt override on each Connect Call Agent node — NOT a variable | The platform sends each Connect Call Agent node's `prompt` to the LLM as the system prompt for that skill | Statically configured via `update_flow`; not runtime-swappable |

**Skill switching mid-call** = flow routing. After the trigger node,
the path goes:

```
inbound_call → ai_data_generation (classify intent into output `detected_intent`)
            → api_request (writes detected_intent to the Contact)
            → split (branches on detected_intent value)
                ├─ "booking"       → connect_call_agent[BOOKING SKILL — per-node prompt = booking-flow instructions]
                ├─ "modification"  → connect_call_agent[MODIFICATION SKILL — per-node prompt = modification-flow instructions]
                ├─ "cancellation"  → connect_call_agent[CANCELLATION SKILL — per-node prompt = cancellation-flow instructions]
                ├─ "faq"           → connect_call_agent[FAQ SKILL — per-node prompt = faq instructions]
                └─ "escalate"      → call (transfer to human)
```

Each `connect_call_agent` node has the SAME `agent_uuid` (the Ellie
agent) but a different `prompt` override that says "you are currently
handling a booking; here are the rules for booking flow only". The
Ellie agent's MASTER prompt (`AiAgentForm[prompts]`) is the "Ellie
OS" — global rules. The per-node prompt is the "active skill".

## What this means for Phase 6

### Tools the bridge actually needs (final list)

| Tool | Backed by | Purpose |
|------|-----------|---------|
| `update_agent({uuid, prompts?, mainGoal?, summaryPrompt?, summaryEnabled?, ...})` | Yii form POST `/ai-agent/<uuid>/edit` | Set the Ellie OS master prompt + post-call extraction prompt |
| `get_agent({uuid})` | Yii form GET `/ai-agent/<uuid>/edit` | Read agent state |
| `list_custom_fields()` | Yii form GET `/management/customer-fields` | Enumerate variable schema |
| `upsert_custom_field({slug, type, name, description?})` | Yii bulk form POST | Add/edit a variable in the schema |
| `delete_custom_field({slugOrUuid})` | Yii bulk form POST (omit row) | Remove a variable |
| `update_contact_attribute({contactUuid, slug, value})` | Yii form POST `/customers/<uuid>/edit` (`SaveCustomerForm[values][<slug>]=<value>`) | Mid-call write to a Contact's Custom Field |
| `get_contact({uuid})` | Yii form GET `/customers/<uuid>/edit` | Read a Contact's current values |

Plus the existing `list_flows`, `get_flow`, `update_flow`,
`validate_flow`, `list_agents`, `list_phone_numbers` from Phase 1-4.

### What the bridge does NOT need

- A "create node of type X" helper — the flow tools already handle
  this; the LLM caller composes flows with the existing primitives.
- A "swap prompt mid-call" tool — not how the platform works.
- A "write attribute via Webhook" tool — there is no such primitive;
  use `update_contact_attribute` instead.

### What this changes in the Phase 6 plan

1. **Drop the misleading claim that Webhook persists state.** Webhook
   is outbound HTTP only. Replace any reference to "Webhook → Custom
   Field" with "the bridge's `update_contact_attribute` tool (or an
   `api_request` node calling it)".
2. **Add `update_contact_attribute` and `get_contact` to the tool list.**
   Same `YiiTransport` infrastructure; no extra recon hop needed at
   build time.
3. **Fix the templating namespace in any user-facing docs.** It's
   `{{ attributes.<slug> }}`, not `{{ variables.<slug> }}`.

## Out of scope for Phase 6 (re-confirmed)

- Custom Field deletion convention — first integration test catches it.
- Bulk Custom Field creation in one API call — single-upsert is enough;
  callers can loop.
- Contact CRUD beyond attribute updates (creating contacts, deleting
  contacts, listing contacts) — Phase 6.5 if needed for tests; defer
  otherwise.
- Actions (`/v1/action/*`) — Phase 7.
- Voices, Conversations, Widgets, Automation V2 — deferred.
