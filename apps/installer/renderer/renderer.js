// renderer.js — vanilla JS driving the installer's single-window UI.
//
// All filesystem and network operations happen in the Electron main
// process via the `window.bridge.*` IPC surface defined in preload.js.

const STATES = ["detecting", "no-bridge", "cookies", "wiring", "done"];

function showState(name) {
  for (const s of STATES) {
    const el = document.getElementById(`state-${s}`);
    if (!el) continue;
    if (s === name) el.classList.remove("hidden");
    else el.classList.add("hidden");
  }
}

function setError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.classList.remove("hidden");
}

function clearError(elId) {
  const el = document.getElementById(elId);
  el.textContent = "";
  el.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Detection bootstrap
// ---------------------------------------------------------------------------

async function detectAndRoute() {
  showState("detecting");
  let state;
  try {
    state = await window.bridge.detectState();
  } catch (err) {
    console.error(err);
    showState("no-bridge");
    setError("locate-error", `Detection failed: ${err.message}`);
    return;
  }

  // Update footer with the real auth path
  document.getElementById("footer-auth-path").textContent = state.authFile;

  if (!state.bridgeServerExists) {
    showState("no-bridge");
    return;
  }

  // Bridge source found. Skip ahead even if auth/config already exist —
  // re-paste / re-wire is always available. Default flow: ask for cookies.
  showState("cookies");
}

// ---------------------------------------------------------------------------
// State: no-bridge handlers
// ---------------------------------------------------------------------------

document.getElementById("btn-locate").addEventListener("click", async () => {
  clearError("locate-error");
  try {
    const result = await window.bridge.locateBridge();
    if (result) {
      // Re-detect now that the path is set
      await detectAndRoute();
    }
  } catch (err) {
    setError("locate-error", err.message);
  }
});

document.getElementById("btn-retry-detect").addEventListener("click", detectAndRoute);

document.getElementById("link-docs").addEventListener("click", (e) => {
  e.preventDefault();
  // No external browser launcher exposed for arbitrary URLs; the install
  // guide lives in the repo's README, so we point the user at the bridge
  // folder if it's been located.
  alert(
    "Install guide: see README.md in the aiployee-bridge folder, " +
    "or visit https://github.com/liamparker17/aiployee-bridge",
  );
});

// ---------------------------------------------------------------------------
// State: cookies handlers
// ---------------------------------------------------------------------------

document.getElementById("btn-open-aiployee").addEventListener("click", async () => {
  try {
    await window.bridge.openAiployee();
  } catch (err) {
    alert(`Could not open browser: ${err.message}`);
  }
});

document.getElementById("cookie-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError("cookies-error");

  const form = e.target;
  const data = new FormData(form);
  const args = {
    accessToken: String(data.get("accessToken") || "").trim(),
    phpsessid: String(data.get("phpsessid") || "").trim(),
    identity: String(data.get("identity") || "").trim(),
    csrf: String(data.get("csrf") || "").trim(),
    apiBase: String(data.get("apiBase") || "").trim(),
  };

  showState("wiring");
  document.getElementById("wiring-status").textContent = "Saving credentials…";

  let authResult, wireResult;
  try {
    authResult = await window.bridge.saveAuth(args);
  } catch (err) {
    showState("cookies");
    setError("cookies-error", err.message);
    return;
  }

  document.getElementById("wiring-status").textContent = "Wiring Claude Desktop…";
  try {
    wireResult = await window.bridge.wireClaude();
  } catch (err) {
    showState("cookies");
    setError("cookies-error", err.message);
    return;
  }

  // Populate done screen
  document.getElementById("summary-auth").textContent = authResult.authFile;
  document.getElementById("summary-config").textContent = wireResult.configPath;
  document.getElementById("summary-backup").textContent = wireResult.backupPath || "(none — no previous config existed)";

  showState("done");
});

// ---------------------------------------------------------------------------
// State: done handlers
// ---------------------------------------------------------------------------

document.getElementById("btn-test").addEventListener("click", async () => {
  const out = document.getElementById("test-result");
  out.className = "result";
  out.textContent = "Starting the bridge and asking it to list its tools…";
  out.classList.remove("hidden");

  let result;
  try {
    result = await window.bridge.testConnection();
  } catch (err) {
    out.classList.add("bad");
    out.textContent = `Test failed: ${err.message}`;
    return;
  }

  if (result.ok) {
    out.classList.add("ok");
    out.textContent = `✓ Bridge responded with ${result.toolCount} MCP tools. Reopen Claude Desktop and try asking "What AIployee flows do I have?"`;
  } else {
    out.classList.add("bad");
    out.textContent = `Test failed: ${result.error}\n${result.stderr || ""}`;
  }
});

document.getElementById("btn-repaste").addEventListener("click", () => {
  // Wipe the form values and route back to the cookies screen
  document.getElementById("cookie-form").reset();
  clearError("cookies-error");
  document.getElementById("test-result").classList.add("hidden");
  showState("cookies");
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

detectAndRoute();
