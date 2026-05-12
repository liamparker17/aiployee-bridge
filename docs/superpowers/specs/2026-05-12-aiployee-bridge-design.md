# aiployee-bridge — Design

**Date:** 2026-05-12
**Author:** Liam Parker
**Status:** Draft — Phase 0 (recon) is gating implementation.

## Goal

A standalone MCP server, `aiployee-bridge`, that lets an LLM client build
and edit AIployee Flows by calling typed tools over HTTP — not by driving
the AIployee web UI through Chrome.

Success bar: "Build me an FAQ flow with Tracey answering and a transfer-to-
human branch" completes in 3–5 tool calls with zero DOM automation.

## IP boundaries (load-bearing)

The bridge is its own product, distinct from any other tool the author
maintains, including `architect-tool`.

- Zero source code imported, vendored, or copy-pasted from
  `architect-tool` (or any other proprietary codebase).
- Zero runtime dependency on `architect-tool`. After auth setup, the
  bridge speaks only HTTPS to `aiployee.jobix.ai`.
- `architect-tool` may be used **only** during Phase 0 recon, as an
  external instrument for capturing HAR traffic. HAR files are
  observations of AIployee's own wire format and are not derivative of
  architect-tool.
- Both tools may coexist as separate MCP servers in an LLM client's
  configuration. They do not call each other.
- The deliverable, if licensed to a third party, is this repo only.

Licensing of this repo: proprietary, all rights reserved (see `LICENSE`).

## Non-goals

- No DOM scraping at runtime.
- No login automation. Auth setup is a one-time manual step that captures
  cookies/bearer from a logged-in browser session and stores them in
  `~/.aiployee-bridge/auth.json`.
- No bundled UI. This is a headless MCP server.
- No attempt to support multiple tenants in one process. One bridge
  instance = one tenant.

## Phases

| Phase | Output | Commit |
|-------|--------|--------|
| 0 — Recon | `recon/har/*.har`, `recon/notes/*.md` documenting endpoints, auth, payload shapes for every Core and Discovery tool below. | One commit: "phase 0: recon". |
| 1 — HTTP client | `src/client/*` — typed methods for the endpoints recon uncovered. Mirrors AIployee's wire format exactly. | "phase 1: http client". |
| 2 — Flow schema + validators | `src/schema/flow.ts` — normalised Flow JSON, local validators run before any server call. | "phase 2: flow schema". |
| 3 — Tool group implementations | `src/tools/flows.ts`, `agents.ts`, `discovery.ts` — plain async fns; library-usable without MCP. | "phase 3: tools". |
| 4 — MCP wrapping | `src/mcp-server.ts` over `@modelcontextprotocol/sdk`. | "phase 4: mcp". |
| 5 — Integration tests | `tests/*.test.ts` against the live tenant, covering happy paths and the known validator failure modes. | "phase 5: tests". |

Each phase is reviewable on its own. No code is written for phase N until
phase N-1 is committed.

## MCP tool surface

### Core (must-haves)

- `list_flows` → `[{uuid, name, status, modified_at}]`
- `get_flow(uuid)` → normalised Flow JSON
- `create_flow(name, description?)` → `{uuid}` (does not auto-open)
- `update_flow(uuid, flow_json)` — local validation first; server save second
- `delete_flow(uuid)`
- `validate_flow(uuid)` → `[{node_id, severity, message}]`
- `set_flow_status(uuid, "Active"|"Inactive")` — refuses to activate if
  `validate_flow` returns errors

### Discovery (must-haves)

- `list_agents()` → `[{id, name, description, voice, language, active}]`
- `list_phone_numbers()` → must include current assignment, not just the
  number (the UI hides numbers already assigned to other flows)
- `list_groups()` / equivalent named external entities the editor binds
  to (full list pinned during recon)

### Per-node helpers (must-haves)

- `copy_agent_to_node(flow_uuid, node_id, source_agent_id)` — surfaces
  the "Copy agent and bind to this node" server-side clone discretely,
  not buried inside `update_flow` semantics.

## Flow JSON schema

Normalised, camelCase shape exposed at the tool I/O boundary. Mapped 1:1
to AIployee's wire format inside the client. Wire shape is preserved
verbatim on the wire (e.g. `"agent_type": "AI Agent"` with the space).

```
Flow {
  uuid: string
  name: string
  status: "Active" | "Inactive"
  modifiedAt: string  // ISO 8601
  nodes: Node[]
  connections: Connection[]
}

Node {
  id: string
  type: string        // e.g. "Inbound Call", "Connect Call Agent", "Split", "Email"
  position: { x: number, y: number }
  config: Record<string, unknown>   // node-type-specific, validated by schema/nodes/<type>.ts
  sockets: { in: string[], out: string[] }
}

Connection {
  from: { nodeId: string, socketKey: string }
  to:   { nodeId: string, socketKey: string }
}
```

## Local validation (before server roundtrip)

Run by `update_flow` and `set_flow_status`:

1. Exactly one trigger node.
2. Every connection's `from`/`to` references an existing node and socket.
3. Split node output percentages sum to 100.
4. Inbound Call has a non-empty, assigned phone-number list.
5. Connect Call Agent has an agent picked.
6. Email node has both `builderType` and a body.
7. No two flows in the workspace claim the same inbound number while
   both `Active`. (Cross-flow; resolved at `set_flow_status` time using
   `list_phone_numbers` data.)

Validation errors are thrown with `{node_id, severity, message}` matching
the server-side error shape, so callers can treat both layers uniformly.

## Auth

One-time setup CLI: `aiployee-bridge auth` walks the user through pasting
the bearer/cookies from their logged-in browser. Stored at
`~/.aiployee-bridge/auth.json` with 0600 perms. The MCP server refuses to
start if the file is missing or expired.

No automated login. Ever.

## Error handling

- HTTP errors surface verbatim status + body to the caller.
- Local validation failures throw before any HTTP call.
- Server validation failures from `validate_flow` are returned as a
  structured list, not thrown.
- Schema drift: if a response shape doesn't match the recon-pinned shape,
  log the diff and fail loudly. Do not silently coerce.

## Tests

Integration tests against the real tenant only. Mocks lie about validator
behaviour — the validator is the entire reason this bridge exists. Tests
explicitly cover the validator failure modes called out in the source
spec:

- Inbound Call with empty phone list.
- Inbound Call with typed-but-unassigned number.
- Connect Call Agent with no agent picked.
- Activating Flow B while Flow A holds the same inbound number.

## Repo layout

```
aiployee-bridge/
├── package.json
├── tsconfig.json
├── LICENSE
├── README.md
├── .gitignore
├── docs/superpowers/specs/2026-05-12-aiployee-bridge-design.md
├── recon/
│   ├── har/         # captured HAR files (gitignored)
│   └── notes/       # markdown distillation of each endpoint
├── src/
│   ├── client/      # HTTP client
│   ├── schema/      # Flow JSON + zod validators
│   ├── tools/       # flows.ts, agents.ts, discovery.ts
│   ├── index.ts     # library entrypoint
│   └── mcp-server.ts
└── tests/
```
