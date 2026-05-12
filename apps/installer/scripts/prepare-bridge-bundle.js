#!/usr/bin/env node
/**
 * prepare-bridge-bundle.js — populate apps/installer/bundled-bridge/ with
 * everything the installer needs to embed inside its packaged binary:
 *
 *   bundled-bridge/
 *     dist/             — compiled MCP server (the bridge itself)
 *     node_modules/     — production-only deps (@modelcontextprotocol/sdk, zod)
 *     package.json      — minimal package.json so Node can resolve modules
 *
 * Runs as a `prebuild` script. Idempotent — wipes and rebuilds bundled-bridge
 * on every invocation so stale artifacts can't sneak into a release.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { execSync } = require("node:child_process");

const INSTALLER_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(INSTALLER_DIR, "..", "..");
const BUNDLE_DIR = path.join(INSTALLER_DIR, "bundled-bridge");

function log(msg) {
  process.stdout.write(`[prepare-bridge-bundle] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[prepare-bridge-bundle] ERROR: ${msg}\n`);
  process.exit(1);
}

async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}

async function copyDir(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(s, d);
    } else if (entry.isFile()) {
      await fsp.copyFile(s, d);
    }
  }
}

(async () => {
  // ---------------------------------------------------------------------
  // Step 1: ensure the bridge is built
  // ---------------------------------------------------------------------
  const distPath = path.join(REPO_ROOT, "dist", "mcp-server.js");
  if (!fs.existsSync(distPath)) {
    log("dist/mcp-server.js not found — running `npm run build` in repo root");
    try {
      execSync("npm run build", { cwd: REPO_ROOT, stdio: "inherit" });
    } catch (err) {
      fail(`bridge build failed: ${err.message}`);
    }
    if (!fs.existsSync(distPath)) {
      fail("dist/mcp-server.js still missing after build");
    }
  } else {
    log("dist/mcp-server.js present");
  }

  // ---------------------------------------------------------------------
  // Step 2: wipe and recreate bundled-bridge/
  // ---------------------------------------------------------------------
  log(`wiping ${BUNDLE_DIR}`);
  await rmrf(BUNDLE_DIR);
  await fsp.mkdir(BUNDLE_DIR, { recursive: true });

  // ---------------------------------------------------------------------
  // Step 3: copy compiled bridge sources
  // ---------------------------------------------------------------------
  log("copying dist/ → bundled-bridge/dist");
  await copyDir(path.join(REPO_ROOT, "dist"), path.join(BUNDLE_DIR, "dist"));

  // ---------------------------------------------------------------------
  // Step 4: minimal package.json — type:module, name, main, deps only.
  // We strip "private" so npm install --omit=dev doesn't complain about
  // workspace context, and we pin the same dep versions as the repo.
  // ---------------------------------------------------------------------
  log("writing bundled-bridge/package.json");
  const repoPkg = JSON.parse(
    await fsp.readFile(path.join(REPO_ROOT, "package.json"), "utf8"),
  );
  const bundledPkg = {
    name: "aiployee-bridge-bundled",
    version: repoPkg.version,
    type: "module",
    main: "dist/mcp-server.js",
    dependencies: repoPkg.dependencies,
  };
  await fsp.writeFile(
    path.join(BUNDLE_DIR, "package.json"),
    JSON.stringify(bundledPkg, null, 2),
    "utf8",
  );

  // ---------------------------------------------------------------------
  // Step 5: install ONLY runtime deps in bundled-bridge/
  //   - --omit=dev   → skip TypeScript, tsx, @types/node etc.
  //   - --ignore-scripts → never run package install hooks (security)
  //   - --no-audit / --no-fund → quieter output, faster
  //   - --package-lock=false → bundle is read-only at runtime; no need
  //     to ship a lockfile we'll never use
  // ---------------------------------------------------------------------
  log("installing runtime deps into bundled-bridge/node_modules");
  try {
    execSync(
      "npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false",
      { cwd: BUNDLE_DIR, stdio: "inherit" },
    );
  } catch (err) {
    fail(`npm install in bundled-bridge failed: ${err.message}`);
  }

  // ---------------------------------------------------------------------
  // Step 6: sanity check
  // ---------------------------------------------------------------------
  const mustExist = [
    path.join(BUNDLE_DIR, "dist", "mcp-server.js"),
    path.join(BUNDLE_DIR, "package.json"),
    path.join(BUNDLE_DIR, "node_modules", "@modelcontextprotocol", "sdk"),
    path.join(BUNDLE_DIR, "node_modules", "zod"),
  ];
  for (const p of mustExist) {
    if (!fs.existsSync(p)) {
      fail(`expected path missing after bundle: ${p}`);
    }
  }

  // Size summary
  function dirSize(p) {
    if (!fs.existsSync(p)) return 0;
    let total = 0;
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const child = path.join(p, entry.name);
      if (entry.isDirectory()) total += dirSize(child);
      else if (entry.isFile()) total += fs.statSync(child).size;
    }
    return total;
  }
  const totalBytes = dirSize(BUNDLE_DIR);
  log(`bundle ready at ${BUNDLE_DIR} (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
})();
