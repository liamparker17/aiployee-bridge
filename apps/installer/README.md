# AIployee Bridge Installer

Self-contained Electron desktop app. Bundles the bridge runtime inside its
own binary — **the user does NOT need Node.js, npm, or Git installed**.
Walks a non-technical user through:

1. Pasting their four AIployee session cookies (`access_token`, `PHPSESSID`, `_identity`, `_csrf`).
2. Writing `~/.aiployee-bridge/auth.json` (delegates to the bundled bridge's own `auth` subcommand for cookie validation).
3. Editing the user's Claude Desktop config to register `aiployee-bridge` as an MCP server. The config's `command` points at the installer's OWN binary (`process.execPath`) with `env: { ELECTRON_RUN_AS_NODE: "1" }`, so Claude Desktop launches the bundled bridge using the Electron-bundled Node runtime — no system Node required.
4. Running a connection test that spawns the bundled bridge in MCP stdio mode and asserts `tools/list` returns the expected tool count.

## How the bundling works

The bridge is copied into the packaged binary at build time via
electron-builder's `extraResources` config:

```
<installer-binary>/
  Contents/Resources/bridge/         (macOS)
  resources/bridge/                  (Windows, Linux)
    dist/                            ← compiled MCP server
    node_modules/                    ← @modelcontextprotocol/sdk + zod only
    package.json                     ← minimal, type:module
```

`scripts/prepare-bridge-bundle.js` is the `prebuild` hook that:

1. Builds the bridge (`npm run build` in the repo root) if `dist/mcp-server.js` is stale.
2. Wipes and recreates `apps/installer/bundled-bridge/`.
3. Copies `dist/` from the repo root.
4. Writes a minimal `package.json` (production deps only).
5. Runs `npm install --omit=dev --ignore-scripts` inside `bundled-bridge/` to materialise the runtime `node_modules/`.

electron-builder then picks up `bundled-bridge/` and writes it as
`resources/bridge/` inside the installed app.

At runtime:
- **Packaged mode** (`app.isPackaged === true`): the installer resolves the bundled script via `process.resourcesPath/bridge/dist/mcp-server.js` and spawns it with `process.execPath` (the installer binary itself) + `ELECTRON_RUN_AS_NODE=1`.
- **Dev mode** (`npm start`): the installer walks up two directories from `__dirname` to find the repo checkout's `dist/mcp-server.js` and spawns it with system `node` so behaviour matches the CLI walkthrough exactly.

## Development

```sh
cd apps/installer
npm install
npm start
```

`npm start` opens the installer window pointed at the parent `aiployee-bridge` source tree (it walks up two directories to find `dist/mcp-server.js`). Make sure you've run `npm install && npm run build` in the repo root first so `dist/mcp-server.js` exists.

## Packaging

```sh
# From the repo root, build for the current OS:
npm run installer:build

# Or from this folder, target a specific OS:
cd apps/installer
npm run build:win
npm run build:mac
npm run build:linux
```

Output lands in `apps/installer/release/`. Per-OS targets:

| OS | Format | Notes |
|---|---|---|
| Windows | NSIS `.exe` installer | Unsigned by default — Windows SmartScreen will warn on first launch; click "More info" → "Run anyway". For a signed build, set `CSC_LINK` and `CSC_KEY_PASSWORD` env vars per electron-builder's docs. |
| macOS | `.dmg` (arm64 + x64) | Unsigned by default — Gatekeeper will refuse on first launch; right-click → Open. For a signed build, provide an Apple Developer ID via `CSC_LINK` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`. |
| Linux | AppImage | Make executable with `chmod +x` and run directly. |

## Architecture

- **`src/main.js`** — Electron main process. ALL filesystem/process operations live here. Resolves OS-specific paths, shells out to `node dist/mcp-server.js auth ...` for credential persistence, atomically rewrites Claude Desktop config with backups, runs the connection test by speaking MCP stdio directly to a spawned bridge.

- **`src/preload.js`** — Tiny context-isolated bridge exposing only the named IPC handlers (`detectState`, `saveAuth`, `wireClaude`, `testConnection`, `openAiployee`, `locateBridge`) to the renderer. The renderer has zero direct filesystem or subprocess access.

- **`renderer/index.html`** — Single-page UI. Five states (`detecting`, `no-bridge`, `cookies`, `wiring`, `done`); states are sibling `<section>`s toggled via a `.hidden` class. No framework, no build step on the frontend side — just three flat files.

- **`renderer/renderer.js`** — Vanilla JS event handlers calling `window.bridge.*` (defined in preload).

- **`renderer/styles.css`** — Dark-theme styling, ~250 lines, no external assets.

## Locating the bridge source

By default, the installer looks for `dist/mcp-server.js` two levels above its own `__dirname` — which works in dev (when run from inside `apps/installer/`) but NOT when shipped as a packaged binary, because `__dirname` then points inside `app.asar`.

Two resolution paths the user can take if auto-detection fails:

1. **Env var** — set `AIPLOYEE_BRIDGE_PATH` to the absolute path of the cloned aiployee-bridge folder before launching the installer.
2. **GUI** — click "Choose folder…" on the `no-bridge` screen and pick the folder. This sets `process.env.AIPLOYEE_BRIDGE_PATH` for the duration of the installer session.

In a future iteration the installer could embed a minified copy of the MCP server inside the binary; for now it points at an existing clone so the bridge and installer can be updated independently.

## Security model

- The renderer process has `contextIsolation: true` and `nodeIntegration: false`. It cannot read files, spawn processes, or make network requests directly.
- All cookie validation runs in main-process Node code (CR/LF / semicolon rejection) before any file write — see `validateCookieValue` in `src/main.js`.
- The Claude Desktop config is mutated via atomic write (write to `.tmp-<ts>`, then `rename`) with a timestamped `.backup-<ts>` copy of any pre-existing file.
- A malformed pre-existing config is moved to `.broken-<ts>` rather than silently overwritten; the user is shown an error so they can recover.
- The installer never logs cookie values, never copies them to the system clipboard, and never sends them anywhere — `saveAuth` only forwards them to the bridge's local `auth` CLI which writes them to disk with mode 0600.
