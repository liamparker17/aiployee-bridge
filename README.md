# aiployee-bridge

MCP server that exposes [AIployee](https://aiployee.jobix.ai) Flows as
high-level tool calls. Lets an LLM client (Claude, etc.) build, edit,
validate, and activate workflows in 3–5 tool calls instead of 20–30 rounds
of DOM scraping.

**Status:** Phase 0 — reconnaissance. The HTTP client and MCP tools are
derived from captured wire traffic against the live tenant; nothing is
implemented until recon is complete and the wire format is documented.

## Why this exists

AIployee's flow editor at `/flows` is a React + Material UI app. Driving
it through Chrome works but is fragile and burns LLM context. This bridge
moves the integration boundary from the DOM to the HTTP/RPC layer that
the editor already speaks to — once — and exposes it as MCP.

## What it is not

This bridge has **no runtime dependency on architect-tool** or any other
browser-automation tool. Once auth is set up, it speaks HTTPS directly
to `aiployee.jobix.ai`. Architect-tool is used (optionally) only during
Phase 0 to capture HAR traffic from the live UI.

## IP / licensing

Proprietary. See `LICENSE`. Distinct codebase, distinct license, distinct
deliverable from any other tool the author maintains.

## Status when complete

See `docs/superpowers/specs/2026-05-12-aiployee-bridge-design.md` for the
full design, phases, and tool surface.
