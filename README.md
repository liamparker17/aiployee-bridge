# aiployee-bridge

MCP server that exposes the AIployee Flows API as high-level tool calls so an
LLM client can build and edit flows in 3–5 tool calls instead of 20–30 rounds
of DOM scraping.

## What it is

`aiployee-bridge` is a standalone stdio MCP server. It speaks HTTPS directly
to `https://dashboard-api.jobix.ai/v1` (and, for Yii surfaces, to
`https://aiployee.jobix.ai`) — no browser automation, no architect-tool
dependency. Wire it into Claude Desktop, Cursor, Windsurf, or Continue; the
LLM gets tools covering flow listing, inspection, editing, validation, agent
enumeration, phone-number lookup, agent prompt editing, custom-field CRUD,
and contact attribute writes.

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

- **Permissive node types.** Eleven node types fall through to a `RawConfig`
  catch-all until their `data` shapes are fully documented: `internet_call`,
  `event`, `now`, `split`, `delay`, `filter`, `update_data`, `sms`, `email`,
  `api_request`, `ai_data_generation`. Flows containing these nodes round-trip
  safely (read and save preserve the original data opaquely), but local
  validation via `validate_flow` does not constrain their `data` block.

## Development

Run unit tests:

```sh
npm test
```

Run live integration tests (requires auth and a sandbox environment):

```sh
AIPLOYEE_BRIDGE_LIVE=1 npm test
```

For design decisions and endpoint documentation see
`docs/superpowers/specs/2026-05-12-aiployee-bridge-design.md` and
`recon/notes/01-api.md`.

## IP / licensing

Proprietary. See `LICENSE`. Distinct codebase, distinct license, distinct
deliverable from any other tool the author maintains. Not open source.
