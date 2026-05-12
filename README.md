# aiployee-bridge

MCP server that exposes the AIployee Flows API as high-level tool calls so an
LLM client can build and edit flows in 3–5 tool calls instead of 20–30 rounds
of DOM scraping.

## Background — what this is for

**What is AIployee?** AIployee (`aiployee.jobix.ai`) is a hosted platform for
building voice + chat AI agents and the **flows** that orchestrate them
(triggers → agent calls → branching logic → emails / SMS / API calls). Flows
are graphs of nodes; each node has a typed config block. The platform has a
visual editor in the browser plus a private JSON API at
`dashboard-api.jobix.ai/v1/*` for the editor itself.

**What is MCP?** [Model Context Protocol](https://modelcontextprotocol.io) is
the standard for letting an LLM client (Claude Desktop, Cursor, Windsurf,
Continue, etc.) call typed tools provided by a local process. The LLM sees a
list of tools, picks one, fills in arguments, and the local process executes
it. MCP servers usually speak stdio JSON-RPC.

**Why this bridge exists.** Without it, an LLM trying to "go change the
opening greeting on Tracey to X" has to drive a real browser, scrape the DOM,
click form fields, and submit Yii forms — 20–30 brittle tool calls and 60+
seconds of latency. With `aiployee-bridge`, the same task is one MCP call:
`update_agent({uuid, openingGreeting: "..."})`. The bridge speaks HTTPS
directly to AIployee's API (and to the Yii form endpoints where there is no
JSON API) and returns clean JSON DTOs.

**Who this is for.** Anyone using a hosted AIployee tenant who wants an
LLM-driven workflow over their flows, agents, custom fields, and conversation
records. **You need an existing AIployee account** — this is not a
replacement for AIployee, it's a programmatic surface over your own tenant.

**What it is NOT.**
- Not a CLI for managing flows by hand. The only CLI subcommand is `auth`
  (one-time credential setup). All flow / agent / contact operations are MCP
  tools driven by an LLM client.
- Not a browser-automation tool. No headless Chrome, no Playwright, no DOM
  scraping for the JSON-API surfaces. Yii form pages ARE scraped (because
  AIployee renders them server-side), but with targeted regex, not a browser.
- Not affiliated with `architect-tool`. Distinct codebase, distinct purpose,
  distinct deliverable — `aiployee-bridge` runs standalone on Node 20+.

## What it is

`aiployee-bridge` is a standalone stdio MCP server. It speaks HTTPS directly
to `https://dashboard-api.jobix.ai/v1` (and, for Yii form surfaces, to
`https://aiployee.jobix.ai`) — no browser automation, no architect-tool
dependency. Wire it into Claude Desktop, Cursor, Windsurf, or Continue; the
LLM gets tools covering flow listing, inspection, editing, validation, agent
enumeration, phone-number lookup, agent prompt editing, custom-field CRUD,
contact attribute writes, flow activation, conversation-record reading, and
test-widget URL generation. **17 MCP tools total** (see "Tools exposed"
below).

## Can it build flows end-to-end without a browser?

**Yes.** Install the bridge, wire it into Claude Desktop, ask Claude in plain
English to build a flow, and Claude will create it on your AIployee tenant
**without ever opening a browser at runtime**. No headless Chrome, no
Playwright, no Puppeteer, no Selenium, no `architect-tool`, no DOM scraping
for flow creation. You also do not need a separate CLI — Claude calls the
MCP tools directly over stdio.

Example end-to-end interaction in Claude Desktop, after the bridge is
installed:

> **You:** Build a flow that answers inbound calls on +27877295318, connects
> to my Tracey agent, and on a transfer outcome routes to the human queue.
>
> **Claude (under the hood):**
> 1. `list_phone_numbers` → finds the inbound number's UUID.
> 2. `list_agents` → finds Tracey's UUID.
> 3. Constructs a `FlowDTO` in memory: `inbound_call → connect_call_agent`
>    with a branch on the "Transferred" outcome to a human-queue node.
> 4. `validate_flow` → local graph validation (runs entirely in Node, no
>    network call).
> 5. `update_flow` → one POST to `/v1/nodes/save`, flow now exists on your
>    AIployee tenant.
> 6. Optionally `set_flow_status({status:"Active", confirm:<flow-name>})` →
>    flips the flow live. The bridge enforces the confirm-token gate AND
>    refuses if another `Active` flow already owns the inbound number.
>
> Total wall-clock: a few seconds, dominated by Claude's thinking. No
> browser was launched at any step.

## How does it access AIployee without browser automation?

It pretends to be the AIployee web app. Here's the actual mechanism, no
hand-waving:

**The AIployee editor is a single-page app.** When you click "Save" in the
visual flow editor at `aiployee.jobix.ai`, the browser fires a
`POST https://dashboard-api.jobix.ai/v1/nodes/save` with a JSON body and an
`Authorization: Bearer <access_token>` header (where `<access_token>` is
the value of your `access_token` cookie). That endpoint is a private JSON
API — but it's a regular HTTPS endpoint, not a browser-only RPC channel.

**The bridge calls those same endpoints directly.** From
`src/client/flows.ts`:

```ts
await transport.request<void>({
  method: "POST",
  path: "/nodes/save",
  body: <wire-shape>,
});
```

`transport.request()` runs `globalThis.fetch(url, {method, headers:
{Authorization: "Bearer <token>", ...}, body: JSON.stringify(...)})` — Node
20+'s built-in `fetch`. That's the entire transport mechanism for the
`/v1/*` surface. AIployee's server accepts the call because the bearer
token is identical to the one its own SPA sends.

**Auth is your own browser session, copied once.** You open
`aiployee.jobix.ai` in any browser where you're already logged in, copy
four cookie values out of DevTools (`access_token`, plus
`PHPSESSID` / `_identity` / `_csrf` if you want the Yii tools), paste them
into `aiployee-bridge auth ...`. That writes `~/.aiployee-bridge/auth.json`
(mode 0600). After that, the browser is closed and **never used again** —
the bridge replays those cookies on every API call. This is the same
cookie set your browser already holds while you're logged in; the bridge
is not bypassing authentication, it's using your authenticated session.
When cookies expire (~7 days for `_identity`, sooner for `PHPSESSID`), the
bridge throws a clear error telling you to refresh them and re-run
`aiployee-bridge auth`.

**Two transport classes, one philosophy:**

| Transport | File | Used for | Mechanism |
|---|---|---|---|
| `Transport` (JSON API) | `src/client/transport.ts` | Flows, validation, phone numbers, dropdowns, `set_flow_status`, `run_flow_test` | `fetch` POST/GET/PATCH with `Authorization: Bearer <token>`. Unwraps the `{success, code, result, errors}` envelope. Throws `ApiError` on `success: false`. |
| `YiiTransport` (HTML forms) | `src/client/yii.ts` | Agents, Custom Fields, Contacts, `list_flow_runs`, `get_flow_run` | `fetch` GET to render the Yii form page, parses the HTML with targeted regex (no DOM library), merges your update over the parsed field state, POSTs `application/x-www-form-urlencoded` back to the same form action URL with `Cookie:` + `X-CSRF-Token` headers. |

The Yii path exists because three AIployee surfaces (Agents / Custom Fields
/ Contacts) and the Conversations page have no JSON-API equivalent — they're
server-rendered forms. The bridge still doesn't drive a browser to use them;
it does GET-the-HTML / parse-fields / merge / POST-form-encoded. Same auth
state your browser uses, no DOM rendering, no clicks, no waits.

**Runtime dependencies in full:** look at `package.json`. The only entries
under `dependencies` are `@modelcontextprotocol/sdk` (so the LLM client can
talk to the bridge) and `zod` (input validation). No `puppeteer`, no
`playwright`, no `chrome-remote-interface`, no `selenium-webdriver`, no
`jsdom`. Node's built-in `fetch` is the only HTTP client. That's the whole
runtime footprint.

### The one honest limitation: `run_flow_test`

`run_flow_test` returns a `widgetUrl` from
`POST /v1/temporary-agent-widget`. The **human** then opens that URL in a
browser to actually have a test conversation with the flow. The bridge
doesn't simulate the inbound caller — there's no way to do that over the
API. Once you've finished the test conversation in your browser, Claude
calls `get_flow_run` to read the transcript back via the same HTTPS scrape
path. So:

- Building flows = fully automatic, no browser.
- Testing the live behaviour = human-in-the-loop for the conversation itself
  (because YOU need to talk to the agent).
- Reading the resulting transcript / call record = automatic again.

This is called out honestly in the tool's MCP description so Claude tells
you to open the URL rather than pretending it ran the test itself.

## Requirements

| Requirement | Version / Detail |
|---|---|
| Node.js | >= 20.10 (uses native `fetch`, ESM, `node:test`) |
| AIployee account | Active session on `aiployee.jobix.ai` (your own tenant) |
| MCP client | Claude Desktop, Cursor, Windsurf, Continue, or any MCP-stdio host |
| OS | macOS, Linux, or Windows (paths use `~/.aiployee-bridge/`) |
| Runtime deps | `@modelcontextprotocol/sdk` and `zod` only — no browser, no other native libs |

Browser session cookies (`PHPSESSID`, `_identity`, `_csrf`) are needed
ONLY if you want to use the Yii-form tools (Agents / Custom Fields /
Contacts). The pure-JSON Flows tools need only the bearer token.

## Quick start

### 1. Clone and build

```sh
git clone https://github.com/liamparker17/aiployee-bridge.git
cd aiployee-bridge
npm install
npm run build
```

Requires Node >= 20.10.

### 2. One-time auth setup

The bridge authenticates with a bearer token taken from the `access_token`
cookie on `aiployee.jobix.ai`.

**How to get the token (three steps):**

1. Open `https://aiployee.jobix.ai` in any browser where you are already
   logged in.
2. Open DevTools (F12) -> Application -> Cookies -> `https://aiployee.jobix.ai`.
3. Copy the value of the `access_token` cookie.

Then save it:

```sh
node dist/mcp-server.js auth --token <paste-value-here>
# or, if you have run `npm link` or installed globally:
aiployee-bridge auth --token <paste-value-here>
```

To override the API base URL (e.g. a sandbox tenant):

```sh
node dist/mcp-server.js auth --token <value> --api-base https://sandbox-api.jobix.ai/v1
```

Credentials are stored at `~/.aiployee-bridge/auth.json` (mode 0600).

#### Cookie setup for Yii surfaces (Agents, Custom Fields, Contacts)

The flow tools above hit only the JSON API and need just the bearer token.
The Agent / Custom Field / Contact tools hit Yii form endpoints on
`aiployee.jobix.ai` and require browser session cookies in addition to the
token.

1. Open `https://aiployee.jobix.ai` in a browser where you are logged in.
2. Open DevTools (F12) -> Application -> Cookies -> `https://aiployee.jobix.ai`.
3. Copy the values of `PHPSESSID`, `_identity`, and `_csrf`. Copy
   `access_token` too if you haven't already saved it.
4. Run one of:

   ```sh
   # Explicit flags (one per cookie)
   aiployee-bridge auth \
     --token <access_token-value> \
     --cookie PHPSESSID=<value> \
     --cookie _identity=<value> \
     --cookie _csrf=<value>

   # Or paste a curl "Cookie:" header directly (single-shot)
   aiployee-bridge auth \
     --token <access_token-value> \
     --cookies-from-curl "PHPSESSID=...; _identity=...; _csrf=..."
   ```

Without cookies, only the Flows tools work. The Agent / Custom Field /
Contact tools throw a clear `auth incomplete — re-run aiployee-bridge auth
with --cookie flags` error.

### 3. Wire into your MCP client

Add an entry to `claude_desktop_config.json` (same pattern for Cursor,
Windsurf, and Continue):

```json
{
  "mcpServers": {
    "aiployee-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/aiployee-bridge/dist/mcp-server.js"]
    }
  }
}
```

Replace `/absolute/path/to/aiployee-bridge` with the directory where you
cloned the repo. On Windows use forward slashes or escaped backslashes.

Restart the MCP client after editing the config.

### 4. Use it

Open your MCP client (e.g. Claude Desktop). The 17 tools below are now
available to the LLM. You don't call them by hand — you ask the LLM in
plain English and it picks the right tool:

> "What flows do I have? Show me the inactive ones."
>
> → LLM calls `list_flows`, filters status===Inactive, replies in prose.

> "Update Tracey's prompt to say she's a restaurant booking agent for
> L'Elixer, opening at 6pm Mondays through Saturdays."
>
> → LLM calls `get_agent({uuid})` to read current prompt, drafts the new
> prompt, calls `update_agent({uuid, prompts: "..."})`, confirms in prose.

> "Activate the 'After-hours booking' flow."
>
> → LLM calls `list_flows`, finds the flow, calls `set_flow_status(...)`
> with the flow's exact name as the `confirm` token. If another active
> flow already owns the inbound phone number the bridge throws with both
> flow UUIDs and the LLM explains the collision.

> "Show me yesterday's calls and tell me which ones got transferred."
>
> → LLM calls `list_flow_runs`, then `get_flow_run` on the interesting
> ones to read transcripts.

The bridge is read-most-of-the-time and write-when-asked. Confirmation
gates live in the tool layer (`set_flow_status` requires a name match;
write tools that affect production routing surface errors loudly rather
than silently retrying). Read the "Failure modes worth knowing" section
below before you let an LLM activate live numbers.

## Tools exposed

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_flows` | _(none)_ | Array of flow summaries (uuid, name, status, …) |
| `get_flow` | `uuid: string (UUID)` | Full flow DTO including nodes and edges |
| `update_flow` | `flow: FlowDTO` | `{ok: true}` on success; throws `ApiError` on failure |
| `validate_flow` | `flow: FlowDTO` | Array of `ValidationIssue` objects; empty array = no issues |
| `list_agents` | _(none)_ | Array of agent records (uuid, label, …) |
| `list_phone_numbers` | _(none)_ | Object with `inbound`, `outbound`, and `human_agent` arrays |
| `get_agent` | `uuid: string (UUID)` | Full agent DTO (mainGoal, prompts, opening greeting, knowledge, opaque `raw` pass-through) |
| `update_agent` | `uuid: string` + any subset of agent fields | `{ok: true}` on success; partial updates merge into the existing Yii form |
| `list_custom_fields` | _(none)_ | Array of `CustomFieldDTO` (`uuid`, `name`, `type`, `slug`, `description`) |
| `upsert_custom_field` | `CustomFieldDTO` (uuid null for insert) | Saved DTO with server-assigned uuid; updates existing row when uuid or slug matches |
| `delete_custom_field` | `{slug?: string, uuid?: string}` (exactly one) | `{ok: true}` on success; throws if the row is missing |
| `get_contact` | `uuid: string (UUID)` | Contact DTO with attributes map keyed by Custom Field slug |
| `update_contact_attribute` | `{contactUuid, slug, value}` | `{ok: true}`; writes a single attribute via the contact's Yii form |
| `set_flow_status` | `{uuid, status: "Active" \| "Inactive", confirm}` | `{previousStatus, newStatus, changed, phoneNumbersAffected}`; `confirm` MUST equal the flow's current name; refuses on phone-number collision with another Active flow |
| `list_flow_runs` | `{flowUuid?, limit?}` (default 25, max 200) | Array of `FlowRunSummary` (uuid, flowUuid, agentUuid, startedAt, durationS, status, channel) parsed from the `/calls` listing page |
| `get_flow_run` | `{uuid}` | `FlowRunDetail` = summary + `transcript`, optional `nodePath`, free-form `metadata`; parsed from `/calls/<uuid>/details` |
| `run_flow_test` | `{flowUuid}` | `{widgetUrl, hint}` — open the URL in a browser to run a test conversation; the bridge cannot drive the chat headlessly |

All tools return JSON serialised as a single MCP text content block.

## Failure modes worth knowing

- **HTTP 200 with `success: false`.** The AIployee API returns HTTP 200 for
  server-side validation failures, with `success: false` and `errors` populated
  in the envelope. The bridge checks `success` before returning and throws
  `ApiError` in that case — the LLM sees the error message in the tool
  response. Do not mistake a 200 status for a successful write.

- **Token rotation.** The `access_token` cookie has roughly a 7-day TTL. When
  the bridge receives a 401, it surfaces an error telling you to re-run
  `aiployee-bridge auth --token <new-value>`. Repeat the DevTools cookie
  extraction and re-run the auth command.

- **Yii cookies rotate.** `PHPSESSID`, `_identity`, and `_csrf` are invalidated
  when you log out of `aiployee.jobix.ai`, and `_identity` carries a roughly
  7-day TTL; note that `PHPSESSID` is a session cookie and can expire sooner —
  potentially within hours depending on server-side session config — so it may
  need refreshing before `_identity` does. When the Agent / Custom Field /
  Contact tools start erroring, re-run `aiployee-bridge auth` with fresh
  `--cookie` values pulled from DevTools.

- **`set_flow_status` requires the flow's exact name as a `confirm` token,
  and refuses on phone-number collisions.** Activating a flow is a
  two-condition gate: (1) `confirm` MUST equal the flow's current `name`
  exactly — the bridge throws with the expected name quoted if it doesn't
  match, so a caller can't blindly "Active" the wrong UUID; (2) when
  transitioning to Active, the bridge scans every other `Active` flow's
  inbound-call nodes for phone-number overlap and REFUSES with both flow
  UUIDs named on collision. The bridge does NOT offer to deactivate the
  conflicting flow — that's a multi-flow decision the LLM caller can make
  separately if the user explicitly asks. Local validation also runs
  before any PATCH; flows with error-severity issues are refused.

- **`list_flow_runs` / `get_flow_run` scrape Yii HTML.** The `/calls`
  listing and `/calls/<uuid>/details` pages are server-rendered (no JSON
  API). The parsers are defensive and fail loud on listing-row schema
  drift (a row missing the expected `/calls/<uuid>/details` link throws
  with the offending HTML snippet truncated). If the listing page does
  not embed flow-link hrefs, `list_flow_runs` returns the full unfiltered
  set with a `console.warn` rather than silently dropping rows. The
  `nodePath` field on `FlowRunDetail` is optional — surfaced only when
  the platform renders a node-path table.

- **`run_flow_test` cannot drive the chat headlessly.** It returns a
  `widgetUrl` from `POST /v1/temporary-agent-widget`; the user opens it
  in a browser to run the test conversation. The transcript shows up in
  `get_flow_run` once the call completes. The endpoint accepts
  `{flow_uuid}` first; on a 400 mentioning `agent_uuid` the bridge pivots
  to the flow's first `connect_call_agent` node's `agentUuid`. If the
  flow has no agent node the bridge throws a clear "no connect_call_agent
  node" error.

- **Permissive node types.** Eleven node types fall through to a `RawConfig`
  catch-all until their `data` shapes are fully documented: `internet_call`,
  `event`, `now`, `split`, `delay`, `filter`, `update_data`, `sms`, `email`,
  `api_request`, `ai_data_generation`. Flows containing these nodes round-trip
  safely (read and save preserve the original data opaquely), but local
  validation via `validate_flow` does not constrain their `data` block.

## Repo layout

```
src/
  mcp-server.ts        — stdio MCP server entry point; registers all 17 tools
  auth-cli.ts          — `aiployee-bridge auth` subcommand (the ONLY CLI command)
  index.ts             — library entrypoint when used as a Node module
  client/
    transport.ts       — JSON envelope wrapper for /v1/* (bearer auth)
    yii.ts             — Yii form GET/parse/merge/POST transport
    auth.ts            — read/write ~/.aiployee-bridge/auth.json
    flows.ts           — getFlowNodes / saveFlow (low-level)
    flow_status.ts     — read-then-conditional-PATCH activation
    flow_runs.ts       — /calls listing HTML scrape
    flow_run_detail.ts — /calls/<uuid>/details HTML scrape
    test_widget.ts     — /temporary-agent-widget POST + agent_uuid pivot
    agents.ts          — Yii ai-agent edit form get/update
    custom_fields.ts   — Yii customer-fields bulk form
    contacts.ts        — Yii contact form
    discovery.ts       — dropdown / pool endpoints
    index.ts           — Client class factory
  tools/               — thin façade re-exports for the public tool surface
  schema/              — Zod schemas for /v1/* envelopes
  dto.ts               — bridge-facing DTOs (camelCase) + normalize.ts
  normalize.ts         — DTO <-> wire shape conversion
  validate.ts          — local flow-graph validator
tests/
  *.test.ts            — node:test unit tests (no network; injected fetchImpl)
  integration*.test.ts — env-gated live tests (AIPLOYEE_BRIDGE_LIVE=1)
recon/notes/           — endpoint reconnaissance writeups (read these before adding new endpoints)
docs/superpowers/      — design docs + execution plans
```

## Development

Type-check without emitting:

```sh
npm run typecheck
```

Run unit tests (fast, no network):

```sh
npm test
```

Run live integration tests (requires `~/.aiployee-bridge/auth.json` and a
sandbox tenant):

```sh
AIPLOYEE_BRIDGE_LIVE=1 npm test
```

Watch-mode build:

```sh
npm run dev
```

### Adding a new tool

1. Add the recon writeup under `recon/notes/` documenting the endpoint
   (method, path, request shape, response shape — sample with `curl`).
2. Add the implementation under `src/client/<feature>.ts` using
   `c.transport.request(...)` or `c.yiiTransport.fetchHtml(...)`.
3. Add unit tests in `tests/<feature>.test.ts` with an injected
   `fetchImpl` — no real network.
4. Add a thin re-export in `src/tools/<feature>.ts`.
5. Wire the barrel exports in `src/tools/index.ts` and `src/index.ts`.
6. Register the MCP tool in `src/mcp-server.ts` with a descriptive
   `description` (this is what the LLM reads when choosing tools).
7. Update the "Tools exposed" table in this README.

For design context and endpoint documentation:
- `docs/superpowers/specs/2026-05-12-aiployee-bridge-design.md` — overall design
- `docs/superpowers/plans/` — execution plans for each phase
- `recon/notes/` — endpoint-by-endpoint reconnaissance

## IP / licensing

Proprietary. See `LICENSE`. Distinct codebase, distinct license, distinct
deliverable from any other tool the author maintains. Not open source.
