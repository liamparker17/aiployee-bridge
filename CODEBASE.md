# CODEBASE.md — repository manifest

One-screen orientation. Full engineering map is in `CLAUDE.md`. End-user
docs are in `README.md`.

## What's in this repo

Two packages in one tree:

1. **`aiployee-bridge`** (root `package.json`) — Node MCP server that
   exposes the AIployee Flows platform as typed tool calls over stdio.
   Entry: `dist/mcp-server.js`. Built with `npm run build` → tsc.
2. **`apps/installer/`** — Electron GUI installer that wraps the bridge
   in a one-click installer for Claude Desktop. Bundles `dist/` inside
   the binary so the end-user needs no Node install.

## Built artifacts ship via GitHub Releases

Tag `v*.*.*` on `main` → `.github/workflows/release-installer.yml` builds
`.exe` (Windows NSIS), `.dmg` (macOS arm64 + x64), `.AppImage` (Linux)
and attaches them to the release.

## Two HTTP surfaces — the load-bearing fact

AIployee splits its features across:

- **REST** at `dashboard-api.jobix.ai/v1/*` (Bearer auth) — handled by
  `Transport` in `src/client/transport.ts`
- **Yii** at `aiployee.jobix.ai/*` (session cookies + CSRF) — handled
  by `YiiTransport` in `src/client/yii.ts`

`Client` (`src/client/index.ts`) carries both. Every MCP tool ultimately
goes to one of these two transports. The full endpoint map is in
`CLAUDE.md`. The default `apiBase` is `https://dashboard-api.jobix.ai/v1`
— users sometimes paste the Yii host by mistake; check `auth.json` when
debugging.

## How to add a new MCP tool

1. Write the wire call in `src/client/<domain>.ts` (use `transport` for
   REST, `yiiTransport` for Yii forms / HTML scrapes).
2. Wrap it with input validation + DTO shaping in
   `src/tools/<domain>.ts`.
3. Register the tool in `src/mcp-server.ts` with a `server.tool(name,
   description, schema, handler)` call.
4. Run `npm run build` and verify with a `scripts/diag-*.mjs` probe
   against the live tenant.
5. Bump `apps/installer/package.json` version, commit, tag, push.

## Tolerance posture

`src/schema/` parsers and `src/normalize.ts` are intentionally
**permissive** — one weird node should never blow up the whole flow.
Strict zod schemas fall back to passthrough; bad nodes drop with a
`console.warn`. `validate_flow` is where drift surfaces.

## Files you'll read first

- `CLAUDE.md` — engineering / how-to-continue notes for AI assistants
- `src/mcp-server.ts` — the canonical list of every tool the bridge
  exposes (and their wire targets, via the imports at the top)
- `src/client/yii.ts` — how Yii form scraping + CSRF POSTs work
- `scripts/diag-*.mjs` — read-only recon utilities for the live tenant
