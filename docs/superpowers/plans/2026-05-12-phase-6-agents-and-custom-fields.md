# aiployee-bridge — Phase 6: Agents + Custom Fields

**Date:** 2026-05-12
**Status:** Ready for subagent-driven execution.
**Prerequisites:**
- Phase 0–5 committed; v0.1.0 of the bridge is in `main` and tested.
- Recon doc `recon/notes/02-agents-and-database.md` is authoritative for endpoint shapes.

## Goal

Extend the bridge from "AIployee Flows MCP" to "AIployee MCP" by adding
clean DTO-over-form-POST tools for AI Agents and Custom Fields. Hide
Yii form mechanics entirely behind JSON-shaped tools. This is **option
A** from the architecture choice: bridge handles all form scraping,
merging, CSRF, and submission internally; LLM callers see typed DTOs.

## Per-call state pattern (locked decision)

The bridge does **not** pick where per-call state values live during a
call — the **flow** the user builds picks. The bridge provides:

1. Custom Fields CRUD — define the schema (`detected_intent: string`,
   `active_skill: string`, `active_skill_prompt: text`, etc.).
2. Agent CRUD — write the master "OS"-style prompt that references
   those variables via `{{ variables.<slug> }}`.
3. The existing Flow tools (Phase 1-4) — wire LLM classifier nodes,
   per-skill Connect-Call-Agent nodes, and Webhook nodes for variable
   persistence.

The LLM caller composes a state-driven agent with these three
primitives; the bridge never needs to know whether `detected_intent` is
ephemeral or persistent during any given call. That's a flow-design
question, not a bridge-API question.

## Cross-cutting constraints

- Strict TS as before: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Use conditional spreads.
- **No new heavy dependencies.** HTML parsing uses targeted regexes against the Yii form (the form structure is deterministic — see `02-agents-and-database.md`).
- **Fail loud, no silent coercion.** When the bridge can't extract a field it expects, throw with the exact field path. When form POST returns a redirect to anything other than the expected success URL, throw.
- **Wire-format mirroring.** Yii uses bracket notation (`AiAgentForm[prompts]`) — the bridge serialises bracket notation on the wire, even if the DTO is camelCase.
- **Sandbox safety for tests.** Agent integration tests run against `3527076a-...` (Tracey Test). Snapshot+restore in `try/finally`.

## Task 6.1 — Auth extension

**Goal:** `~/.aiployee-bridge/auth.json` carries Yii session cookies in addition to the access_token bearer.

### Schema change

```ts
interface AuthFile {
  // existing fields
  token: string;
  apiBase?: string;
  savedAt: string;

  // new fields (all optional — when absent, Yii-form features are unavailable)
  yiiHost?: string;        // default "https://aiployee.jobix.ai"
  cookies?: {
    PHPSESSID?: string;
    _identity?: string;
    _csrf?: string;
    access_token?: string; // also a cookie value on the Yii host
  };
}
```

### CLI change (`auth-cli.ts`)

`aiployee-bridge auth` accepts new flags:

- `--cookie PHPSESSID=<value>` (repeatable for each named cookie)
- `--cookies-from-curl <string>` — paste a `Cookie:` header verbatim
- `--yii-host <url>` (defaults to `https://aiployee.jobix.ai`)

Stdin mode (`--token -`) is preserved. If the user supplies neither
cookies nor a curl string, the auth file is written without `cookies`
and the bridge starts in flows-only mode; the new agent/custom-fields
tools raise a clear error directing the user to run `auth` again with
cookies.

### How to get the cookies (documented in README)

DevTools → Application → Cookies → `https://aiployee.jobix.ai` →
copy `PHPSESSID`, `_identity`, `_csrf` values. The `--cookies-from-curl`
flag accepts the full Cookie header line from a "Copy as cURL" so the
user can do it in one paste.

### Verification

```
npx tsc -p tsconfig.json --noEmit
npm test           # unit + the 21 existing must still pass
node dist/mcp-server.js auth --token TEST --cookie 'PHPSESSID=abc' --cookie '_identity=def' --cookie '_csrf=ghi'
# inspect ~/.aiployee-bridge/auth.json; delete the test file after.
```

## Task 6.2 — Yii form transport (`src/client/yii.ts`)

**Goal:** a thin layer that handles GET-parse-merge-POST against any Yii ActiveForm endpoint. Reusable for both Agents and Custom Fields.

### Exports

```ts
export interface YiiFormState {
  /** Raw form values keyed by Yii bracket notation, e.g. "AiAgentForm[prompts]". */
  fields: Record<string, string | string[]>;
  /** CSRF token from <meta name="csrf-token"> on the page. */
  csrfToken: string;
  /** Yii's _submission_token form field value (anti-replay nonce). */
  submissionToken: string;
  /** Form action URL as parsed off the <form action="..."> attribute. */
  action: string;
  /** Form method (almost always "POST"). */
  method: string;
}

export interface YiiTransportOptions {
  yiiHost: string;            // e.g. "https://aiployee.jobix.ai"
  cookies: {
    PHPSESSID?: string;
    _identity?: string;
    _csrf?: string;
    access_token?: string;
  };
  fetchImpl?: typeof fetch;
}

export class YiiTransport {
  constructor(opts: YiiTransportOptions);

  /** GET the page and parse the first <form>. Throws when no form is found. */
  getForm(path: string, opts?: { formId?: string }): Promise<YiiFormState>;

  /** POST a merged form (urlencoded). Returns response status + final URL. */
  submitForm(form: YiiFormState, overrides: Record<string, string | string[]>):
    Promise<{ status: number; finalUrl: string; html: string }>;
}
```

### Parser rules

- Use regex/string-walk parsing — DO NOT pull a DOM library. The targeted patterns:
  - `<meta name="csrf-token" content="([^"]+)">` → `csrfToken`.
  - `<form [^>]*action="([^"]+)" [^>]*method="([^"]+)"` (handle order variation) → `action`, `method`.
  - For every `<input|textarea|select>` with a `name` attribute under the chosen form, extract `name` and current value. Handle:
    - `<input type="hidden" name="..." value="...">`
    - `<input type="checkbox" name="..." value="..." checked?>`
    - `<input type="text" name="..." value="...">`
    - `<textarea name="...">VALUE</textarea>` (extract inner HTML, decode entities)
    - `<select name="..."><option value="..." selected>...</option>...</select>` (extract the selected value)
  - Bracket-notation names (e.g. `AiAgentForm[prompts]`, `UpdateOrCreateCustomerFieldForm[fields][1][slug]`) are stored verbatim in `fields`. The caller works in this namespace.
  - Repeated names with `[]` suffix (`AiAgentForm[knowledge_files][]`) become `string[]`.
- Entity decoding: handle `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`, `&apos;`. Do not bring in a full HTML decoder.

### Submission rules

- Merge `overrides` into `fields` (override wins). Re-include `_submission_token` from `form.submissionToken`.
- Encode as `application/x-www-form-urlencoded`. PHP/Yii expects bracket notation verbatim in the body (URL-encoded brackets), values URL-encoded.
- Set headers:
  - `Cookie: PHPSESSID=...; _identity=...; _csrf=...; access_token=...` (only include cookies present)
  - `X-CSRF-Token: <csrfToken>`
  - `Content-Type: application/x-www-form-urlencoded`
  - `Accept: text/html`
  - `Referer: <yiiHost>` (some Yii setups validate)
- Use `redirect: "manual"` so the bridge sees the 302 itself; treat 302 with a `Location` that doesn't contain `?error` (or any error markers) as success. Treat 200 with the same form re-rendered as a validation failure — extract `.has-error` blocks and surface as a structured error.

### Verification

- Unit test parses a small fixture HTML (inline string) containing one Yii form, asserts every field is extracted with bracket notation preserved.
- Unit test for `submitForm` injects `fetchImpl` and asserts:
  - URL-encoded body has bracket-encoded names (`AiAgentForm%5Bprompts%5D=...`)
  - Headers include `X-CSRF-Token` and a Cookie header containing only the cookies that were set.
  - On 302 to `Location: /agents`, returns `{status: 302, finalUrl}` without following.
  - On 200 with `.has-error` divs in the response HTML, throws an error containing the extracted error messages.

```
npx tsc -p tsconfig.json --noEmit
npm test
```

Both clean. No live test in this task.

## Task 6.3 — Agents module (clean DTO, opaque tail)

**Goal:** `update_agent({uuid, prompts?, mainGoal?, openingGreeting?, summaryPrompt?, debugPrompt?, knowledgeText?, knowledgeWebsites?, phoneNumbers?})` does the right thing.

### New files

- `src/client/agents.ts`
- `src/tools/agents.ts` (extends — the existing `listAgents` stays)
- `src/dto-agent.ts` (or extend `src/dto.ts` — implementer's call)

### DTO

```ts
export interface AgentSummary {     // exists; extend if needed
  uuid: string;
  name: string;
}

export interface AgentDetails {
  uuid: string;
  name: string;
  mainGoal: string;
  prompts: string;                  // the master prompt
  openingGreeting: string;
  summaryPrompt: string;            // empty when is_summary_prompt is unchecked
  summaryEnabled: boolean;
  debugPrompt: string;
  debugEnabled: boolean;
  phoneNumbers: string[];           // E.164
  knowledgeText: string;
  knowledgeWebsites: { url: string }[];
  /** Opaque pass-through: every other AiAgentForm field. Don't interpret. */
  raw: Record<string, string | string[]>;
}

export interface AgentUpdate {
  uuid: string;
  // every "clean" field above as optional. Anything in `raw` is also accepted
  // and merged verbatim onto the form.
  name?: string;
  mainGoal?: string;
  prompts?: string;
  openingGreeting?: string;
  summaryPrompt?: string;
  summaryEnabled?: boolean;
  debugPrompt?: string;
  debugEnabled?: boolean;
  phoneNumbers?: string[];
  knowledgeText?: string;
  knowledgeWebsites?: { url: string }[];
  raw?: Record<string, string | string[]>;
}
```

### Functions

- `getAgent(c: Client, uuid: string): Promise<AgentDetails>` — wrap `YiiTransport.getForm("/ai-agent/<uuid>/edit", {formId: "create-agent-form"})`, translate `AiAgentForm[*]` fields to the typed DTO. Anything not in the typed list goes into `raw`.
- `updateAgent(c: Client, update: AgentUpdate): Promise<void>` — calls `getAgent` first to capture current state, then `submitForm` with the overrides. The override map translates DTO fields back to Yii bracket notation. `phoneNumbers`/`knowledgeWebsites` are JSON-stringified into single hidden-field values (verified shape: `["+27..."]`, `[{"url":"..."}]`). Throw `YiiFormError` on failure.

### Tool registration

In `src/mcp-server.ts` add:

| Tool name | Args | Returns |
|---|---|---|
| `get_agent` | `{uuid}` | `AgentDetails` |
| `update_agent` | `AgentUpdate` | `{ok: true}` |

`list_agents` is unchanged (still uses `/v1/r/agents-dropdown`).

### Local validation before submit

- `phoneNumbers`: every entry must start with `+` (E.164). Trim whitespace.
- `prompts`, `mainGoal`, `openingGreeting`, `summaryPrompt`, `debugPrompt`: enforce max length 50,000 chars locally (defensive — the form has no observed limit but a runaway template substitution shouldn't bring down the wire).

### Verification

- Unit tests against the form parser with a saved fixture (inline string mock) — round-trip `getAgent` → `updateAgent` overrides → assert the resulting URL-encoded body has the right keys and values.

## Task 6.4 — Custom Fields module

**Goal:** schema-level CRUD over the bulk Yii form.

### New files

- `src/client/custom_fields.ts`
- `src/tools/custom_fields.ts`

### DTO

```ts
export interface CustomFieldDTO {
  uuid: string | null;       // null for inserts; assigned by server on first save
  name: string;
  type: string;              // observed: "string"; others tba — passthrough as-is
  slug: string;              // the `{{ variables.<slug> }}` key
  description: string;
}
```

### Functions

- `listCustomFields(c): Promise<CustomFieldDTO[]>` — GET the bulk form, extract every `[fields][i][...]` row.
- `upsertCustomField(c, dto): Promise<CustomFieldDTO>` — GET, find row by `slug` (or `uuid` when present), modify in place, POST. Returns the row after re-fetch.
- `deleteCustomField(c, slugOrUuid): Promise<void>` — GET, remove the row from the field map, POST. **Note:** this assumes "omit the row" is the delete convention. The recon doc flags this as unverified. If POST returns the row unchanged, fall back to setting a `_delete` flag if the form has one; if neither works, throw a clear "delete convention unverified — please raise an issue" error.

### Tool registration

| Tool name | Args | Returns |
|---|---|---|
| `list_custom_fields` | none | `CustomFieldDTO[]` |
| `upsert_custom_field` | `CustomFieldDTO` (uuid optional) | `CustomFieldDTO` |
| `delete_custom_field` | `{slug?: string, uuid?: string}` | `{ok: true}` |

### Type whitelist

Local validation rejects unknown `type` values for now. Observed: `string`. Until each is verified, accept also `number`, `boolean`, `json`, `date` with a warning logged via `onRequest` (the platform may or may not accept these; on rejection the server's error surfaces).

### Verification

- Unit tests for the row-extraction parser (multi-row fixture) and the merge logic (insert, update by slug, delete).

## Task 6.5 — MCP wiring + live tests

**Goal:** tools registered in `mcp-server.ts`, integration tests against the sandbox agent.

### `src/mcp-server.ts` additions

Register the five new tools (`get_agent`, `update_agent`, `list_custom_fields`, `upsert_custom_field`, `delete_custom_field`). All other behaviour unchanged. On startup, when the auth file lacks Yii cookies, register them but make the handlers throw a clear "auth incomplete — re-run `aiployee-bridge auth` with --cookie flags" message.

### `tests/integration-yii.test.ts`

A new file (kept separate from `tests/integration.test.ts` so the gating is independent — same `AIPLOYEE_BRIDGE_LIVE=1` env var, but checks `auth.json` has cookies before any Yii call).

Sequence:
1. `getAgent(AGENT_UUID)` → snapshot the DTO. Assert `mainGoal` and `prompts` are non-empty (real agent).
2. `updateAgent({uuid: AGENT_UUID, mainGoal: snapshot.mainGoal + " [recon ts]"})` → succeeds.
3. `getAgent(AGENT_UUID)` → asserts the new `mainGoal` is persisted.
4. Restore via `updateAgent({uuid, mainGoal: snapshot.mainGoal})` in `try/finally`.

For Custom Fields:
1. `listCustomFields()` → assert ≥ 10 rows (the demo tenant has 54).
2. `upsertCustomField({slug: "recon_test_field", name: "Recon Test", type: "string", description: "ephemeral"})` → returns DTO with assigned uuid.
3. `listCustomFields()` → assert the new row is present.
4. `deleteCustomField({slug: "recon_test_field"})` → succeeds.
5. `listCustomFields()` → assert row is gone.
6. Teardown: if step 4 fails, log the slug LOUDLY to stderr so the user can clean up manually.

Same safety rules as Phase 5: `try/finally`, 30s timeouts per `it`, sandbox-only constants asserted at top, no other agent or field touched.

### Verification

- `npx tsc -p tsconfig.json --noEmit` clean.
- `npm test` (no env var) — 21 existing + new unit tests pass; integration suites skipped.
- `AIPLOYEE_BRIDGE_LIVE=1 npm test` (run only by the human, not the subagents): runs both integration suites end-to-end.

## Out of scope for Phase 6

- Contacts CRUD (`/customers`) — Phase 6.5 if needed.
- Actions CRUD (`/v1/action/*`) — Phase 7.
- Voice catalogue, Conversations, Widgets, Automation V2 — deferred.
- Flow-template generation ("here's an Ellie OS, build me the matching flow") — deliberately not a bridge concern; the LLM caller composes flows from primitives.

## Commit hygiene

- One commit per task (`phase 6: <task name>`).
- Tests committed alongside the code they verify.
- Update root `README.md` once at the end with the new tool surface, the cookie setup steps, and the explicit note that Yii-side features require cookies.
