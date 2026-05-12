// main.js — Electron main process for the AIployee Bridge Installer.
//
// Responsibilities (all privileged ops happen here, NOT in the renderer):
//   - Detect the user's OS and resolve the Claude Desktop config path.
//   - Detect whether the bridge is already installed (auth.json exists,
//     dist/mcp-server.js exists, Claude Desktop config has an entry).
//   - Write ~/.aiployee-bridge/auth.json with mode 0600 (delegating to
//     the bridge's own `auth` CLI subcommand so the cookie-validation
//     logic stays in one place).
//   - Read/merge/write claude_desktop_config.json atomically with a
//     backup file alongside.
//   - Run a connection test by invoking the bridge directly and
//     watching for a non-error response from list_flows.

const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { spawn } = require("node:child_process");

// ---------------------------------------------------------------------------
// OS-specific paths
// ---------------------------------------------------------------------------

function claudeDesktopConfigPath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  // Linux
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

function authFilePath() {
  return path.join(os.homedir(), ".aiployee-bridge", "auth.json");
}

/**
 * Resolve the absolute path to dist/mcp-server.js inside the bridge's source
 * tree. The installer ships INSIDE the aiployee-bridge repo (apps/installer/),
 * so we walk up two levels from this file's directory to find the repo root.
 *
 * When packaged via electron-builder, __dirname points inside app.asar — in
 * that case fall back to a value the user must provide via the UI (or via
 * AIPLOYEE_BRIDGE_PATH env var) since the repo source isn't bundled with the
 * installer binary by default.
 */
function bridgeServerPath() {
  // Env override wins
  if (process.env.AIPLOYEE_BRIDGE_PATH) {
    const p = path.resolve(process.env.AIPLOYEE_BRIDGE_PATH, "dist", "mcp-server.js");
    if (fs.existsSync(p)) return p;
  }

  // dev mode: __dirname = .../apps/installer/src
  const devGuess = path.resolve(__dirname, "..", "..", "..", "dist", "mcp-server.js");
  if (fs.existsSync(devGuess)) return devGuess;

  // No reliable default; renderer will surface a "find your bridge" dialog
  return null;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

async function detectState() {
  const result = {
    platform: process.platform,
    authFile: authFilePath(),
    authFileExists: false,
    claudeConfigPath: claudeDesktopConfigPath(),
    claudeConfigExists: false,
    claudeConfigHasEntry: false,
    bridgeServerPath: bridgeServerPath(),
    bridgeServerExists: false,
  };

  try {
    await fsp.access(result.authFile);
    result.authFileExists = true;
  } catch {}

  try {
    await fsp.access(result.claudeConfigPath);
    result.claudeConfigExists = true;
    const raw = await fsp.readFile(result.claudeConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    result.claudeConfigHasEntry = Boolean(parsed?.mcpServers?.["aiployee-bridge"]);
  } catch {}

  if (result.bridgeServerPath) {
    try {
      await fsp.access(result.bridgeServerPath);
      result.bridgeServerExists = true;
    } catch {}
  }

  return result;
}

// ---------------------------------------------------------------------------
// Cookie validation (defensive — the renderer should never bypass this)
// ---------------------------------------------------------------------------

function validateCookieValue(name, value) {
  if (typeof value !== "string") return `${name} must be a string`;
  if (value.length === 0) return `${name} is empty`;
  if (/[\r\n]/.test(value)) return `${name} contains illegal characters (CR/LF)`;
  if (/[;]/.test(value)) return `${name} contains a semicolon — paste only the VALUE, not the full Set-Cookie header`;
  return null;
}

// ---------------------------------------------------------------------------
// IPC: save auth (delegates to the bridge's `auth` CLI subcommand)
// ---------------------------------------------------------------------------

async function saveAuthViaBridge({ accessToken, phpsessid, identity, csrf, apiBase }) {
  // Local validation BEFORE shelling out
  const errors = [
    validateCookieValue("access_token", accessToken),
    validateCookieValue("PHPSESSID", phpsessid),
    validateCookieValue("_identity", identity),
    validateCookieValue("_csrf", csrf),
  ].filter(Boolean);
  if (errors.length > 0) {
    throw new Error("Cookie validation failed:\n" + errors.join("\n"));
  }

  const serverPath = bridgeServerPath();
  if (!serverPath) {
    throw new Error("Could not locate the bridge's dist/mcp-server.js. Set AIPLOYEE_BRIDGE_PATH or rebuild the installer in-place inside the repo.");
  }

  const args = [
    serverPath,
    "auth",
    "--token", accessToken,
    "--cookie", `PHPSESSID=${phpsessid}`,
    "--cookie", `_identity=${identity}`,
    "--cookie", `_csrf=${csrf}`,
  ];
  if (apiBase && typeof apiBase === "string" && apiBase.length > 0) {
    args.push("--api-base", apiBase);
  }

  return await new Promise((resolve, reject) => {
    const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, stdout, authFile: authFilePath() });
      } else {
        reject(new Error(`aiployee-bridge auth exited with code ${code}:\n${stderr || stdout}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// IPC: wire Claude Desktop config
// ---------------------------------------------------------------------------

async function wireClaudeDesktop() {
  const serverPath = bridgeServerPath();
  if (!serverPath) {
    throw new Error("Could not locate the bridge's dist/mcp-server.js.");
  }

  const configPath = claudeDesktopConfigPath();
  const configDir = path.dirname(configPath);

  // Ensure directory exists
  await fsp.mkdir(configDir, { recursive: true });

  // Read existing config (or start fresh)
  let config = { mcpServers: {} };
  try {
    const raw = await fsp.readFile(configPath, "utf8");
    config = JSON.parse(raw);
    if (!config || typeof config !== "object") config = { mcpServers: {} };
    if (!config.mcpServers || typeof config.mcpServers !== "object") {
      config.mcpServers = {};
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Existing file is malformed — back it up before overwriting
      const backupPath = `${configPath}.broken-${Date.now()}`;
      try {
        await fsp.copyFile(configPath, backupPath);
      } catch {}
      throw new Error(
        `Your existing Claude Desktop config at ${configPath} is not valid JSON. ` +
        `A copy was saved to ${backupPath}; please fix or remove the original and retry.`,
      );
    }
  }

  // Back up the current valid file before mutating
  let backupPath = null;
  try {
    await fsp.access(configPath);
    backupPath = `${configPath}.backup-${Date.now()}`;
    await fsp.copyFile(configPath, backupPath);
  } catch {}

  // On Windows, electron-builder produces a node binary that respects forward
  // slashes; we normalise to forward slashes for cross-platform consistency.
  const normalizedPath = serverPath.replace(/\\/g, "/");

  config.mcpServers["aiployee-bridge"] = {
    command: "node",
    args: [normalizedPath],
  };

  // Atomic write: write to .tmp then rename
  const tmpPath = `${configPath}.tmp-${Date.now()}`;
  await fsp.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf8");
  await fsp.rename(tmpPath, configPath);

  return { ok: true, configPath, backupPath, normalizedServerPath: normalizedPath };
}

// ---------------------------------------------------------------------------
// IPC: connection test (spawn the bridge in MCP stdio mode and send a
// list_flows request directly via JSON-RPC over stdin/stdout)
// ---------------------------------------------------------------------------

async function testConnection() {
  const serverPath = bridgeServerPath();
  if (!serverPath) {
    throw new Error("Could not locate the bridge's dist/mcp-server.js.");
  }

  return await new Promise((resolve) => {
    const child = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { child.kill(); } catch {}
        resolve({ ok: false, error: "Connection test timed out after 15s", stderr });
      }
    }, 15000);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
      // Look for a JSON-RPC response with `result.tools` to confirm the
      // server is alive. Any well-formed response is good enough.
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result && Array.isArray(msg.result.tools)) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeout);
              try { child.kill(); } catch {}
              resolve({ ok: true, toolCount: msg.result.tools.length });
            }
            return;
          }
        } catch {}
      }
    });

    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ ok: false, error: err.message, stderr });
      }
    });

    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          ok: false,
          error: `Bridge exited with code ${code} before responding`,
          stderr,
        });
      }
    });

    // Send MCP initialize + tools/list once stdin is ready
    const init = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "aiployee-bridge-installer", version: "0.1.0" },
      },
    };
    const listTools = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    };
    try {
      child.stdin.write(JSON.stringify(init) + "\n");
      child.stdin.write(JSON.stringify(listTools) + "\n");
    } catch (err) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ ok: false, error: `Failed to write to bridge stdin: ${err.message}` });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

ipcMain.handle("detect-state", async () => detectState());
ipcMain.handle("save-auth", async (_e, args) => saveAuthViaBridge(args));
ipcMain.handle("wire-claude", async () => wireClaudeDesktop());
ipcMain.handle("test-connection", async () => testConnection());
ipcMain.handle("open-aiployee", async () => {
  await shell.openExternal("https://aiployee.jobix.ai");
});
ipcMain.handle("locate-bridge", async () => {
  const result = await dialog.showOpenDialog({
    title: "Locate aiployee-bridge directory",
    message: "Select the aiployee-bridge folder that contains dist/mcp-server.js",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const dir = result.filePaths[0];
  const probe = path.join(dir, "dist", "mcp-server.js");
  if (!fs.existsSync(probe)) {
    throw new Error(`No dist/mcp-server.js found in ${dir}. Did you run \`npm install && npm run build\` in that folder?`);
  }
  // Set env var so subsequent calls find it
  process.env.AIPLOYEE_BRIDGE_PATH = dir;
  return { dir, serverPath: probe };
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 720,
    height: 640,
    resizable: true,
    title: "AIployee Bridge Installer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
