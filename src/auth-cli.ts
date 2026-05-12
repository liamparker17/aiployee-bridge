#!/usr/bin/env node
/**
 * auth-cli.ts — handles `aiployee-bridge auth --token <value>` (and `--token -` for stdin).
 *
 * Called from mcp-server.ts when process.argv[2] === "auth".
 * Writes ~/.aiployee-bridge/auth.json and prints the resolved path.
 * Exit codes: 0 = success, 2 = argument error.
 */

import { createInterface } from "node:readline";
import { saveAuth, DEFAULT_API_BASE, DEFAULT_YII_HOST, type AuthFile } from "./client/auth.js";

const ALLOWED_COOKIE_NAMES = new Set<string>([
  "PHPSESSID",
  "_identity",
  "_csrf",
  "access_token",
]);

export async function runAuthCli(argv: string[]): Promise<void> {
  // argv here is process.argv.slice(3) — everything after "auth"
  let token: string | undefined;
  let apiBase: string | undefined;
  let yiiHost: string | undefined;
  const rawCookies: Record<string, string> = {};
  let cookieFlagProvided = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--token") {
      if (i + 1 >= argv.length) {
        process.stderr.write("value missing after --token\n");
        process.exit(2);
      }
      token = argv[i + 1];
      i++;
    } else if (arg.startsWith("--token=")) {
      token = arg.slice("--token=".length);
    } else if (arg === "--api-base") {
      if (i + 1 >= argv.length) {
        process.stderr.write("value missing after --api-base\n");
        process.exit(2);
      }
      apiBase = argv[i + 1];
      i++;
    } else if (arg.startsWith("--api-base=")) {
      apiBase = arg.slice("--api-base=".length);
    } else if (arg === "--yii-host") {
      if (i + 1 >= argv.length) {
        process.stderr.write("value missing after --yii-host\n");
        process.exit(2);
      }
      yiiHost = argv[i + 1];
      i++;
    } else if (arg.startsWith("--yii-host=")) {
      yiiHost = arg.slice("--yii-host=".length);
    } else if (arg === "--cookie") {
      if (i + 1 >= argv.length) {
        process.stderr.write("value missing after --cookie\n");
        process.exit(2);
      }
      const pair = argv[i + 1] as string;
      i++;
      cookieFlagProvided = true;
      const eq = pair.indexOf("=");
      if (eq === -1) {
        process.stderr.write(`--cookie missing '=' separator (got ${pair.length} chars)\n`);
        process.exit(2);
      }
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (!ALLOWED_COOKIE_NAMES.has(name)) {
        process.stderr.write(`unsupported cookie name '${name}' (allowed: ${[...ALLOWED_COOKIE_NAMES].join(", ")})\n`);
        process.exit(2);
      }
      if (/[\r\n]/.test(value)) {
        process.stderr.write(`cookie '${name}' contains illegal characters (CR/LF)\n`);
        process.exit(2);
      }
      rawCookies[name] = value;
    } else if (arg.startsWith("--cookie=")) {
      const pair = arg.slice("--cookie=".length);
      cookieFlagProvided = true;
      const eq = pair.indexOf("=");
      if (eq === -1) {
        process.stderr.write(`--cookie missing '=' separator (got ${pair.length} chars)\n`);
        process.exit(2);
      }
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (!ALLOWED_COOKIE_NAMES.has(name)) {
        process.stderr.write(`unsupported cookie name '${name}' (allowed: ${[...ALLOWED_COOKIE_NAMES].join(", ")})\n`);
        process.exit(2);
      }
      if (/[\r\n]/.test(value)) {
        process.stderr.write(`cookie '${name}' contains illegal characters (CR/LF)\n`);
        process.exit(2);
      }
      rawCookies[name] = value;
    } else if (arg === "--cookies-from-curl") {
      if (i + 1 >= argv.length) {
        process.stderr.write("value missing after --cookies-from-curl\n");
        process.exit(2);
      }
      const headerLine = argv[i + 1] as string;
      i++;
      cookieFlagProvided = true;
      const strippedA = headerLine.replace(/^cookie:\s*/i, "").trim();
      if (!strippedA) {
        process.stderr.write("--cookies-from-curl value is empty\n");
        process.exit(2);
      }
      parseCookieHeader(headerLine, rawCookies);
    } else if (arg.startsWith("--cookies-from-curl=")) {
      const headerLine = arg.slice("--cookies-from-curl=".length);
      cookieFlagProvided = true;
      const strippedB = headerLine.replace(/^cookie:\s*/i, "").trim();
      if (!strippedB) {
        process.stderr.write("--cookies-from-curl value is empty\n");
        process.exit(2);
      }
      parseCookieHeader(headerLine, rawCookies);
    }
  }

  if (token === undefined) {
    process.stderr.write(
      "aiployee-bridge auth: missing required argument --token <value>\n" +
        "Usage: aiployee-bridge auth --token <value> [--api-base <url>] [--yii-host <url>]\n" +
        "       aiployee-bridge auth --token -  (reads token from stdin)\n" +
        "       aiployee-bridge auth --token <value> --cookie PHPSESSID=<val> --cookie _identity=<val>\n" +
        "       aiployee-bridge auth --token <value> --cookies-from-curl \"PHPSESSID=...; _identity=...\"\n",
    );
    process.exit(2);
  }

  // --token - means read from stdin
  if (token === "-") {
    token = await readStdin();
    token = token.trim();
    if (!token) {
      process.stderr.write("aiployee-bridge auth: stdin was empty — no token read\n");
      process.exit(2);
    }
  }

  if (!token) {
    process.stderr.write("aiployee-bridge auth: --token value must not be empty\n");
    process.exit(2);
  }

  // Validate yiiHost if provided
  if (yiiHost !== undefined) {
    if (!yiiHost.startsWith("http://") && !yiiHost.startsWith("https://")) {
      process.stderr.write(`invalid --yii-host: must start with http:// or https://\n`);
      process.exit(2);
    }
  }

  // If cookie flags were provided but nothing valid was parsed, fail
  if (cookieFlagProvided && Object.keys(rawCookies).length === 0) {
    process.stderr.write("no valid cookies parsed\n");
    process.exit(2);
  }

  // Build cookies object — only defined if we have at least one valid cookie
  const cookies: AuthFile["cookies"] | undefined =
    Object.keys(rawCookies).length > 0
      ? buildCookies(rawCookies)
      : undefined;

  const p = await saveAuth({
    token,
    ...(apiBase !== undefined ? { apiBase } : {}),
    ...(yiiHost !== undefined ? { yiiHost } : {}),
    ...(cookies !== undefined ? { cookies } : {}),
  });

  const resolvedApiBase = apiBase ?? DEFAULT_API_BASE;
  const resolvedYiiHost = yiiHost ?? DEFAULT_YII_HOST;
  const cookieNames = cookies ? Object.keys(cookies).join(", ") : "(none)";

  process.stdout.write(`saved auth to ${p}\n`);
  process.stdout.write(`  api-base: ${resolvedApiBase}\n`);
  process.stdout.write(`  yii-host: ${resolvedYiiHost}\n`);
  process.stdout.write(`  cookies:  ${cookieNames}\n`);
}

/**
 * Parse a Cookie header line (with or without "Cookie: " prefix) into rawCookies.
 * Silently ignores cookie names not in ALLOWED_COOKIE_NAMES.
 */
function parseCookieHeader(headerLine: string, out: Record<string, string>): void {
  // Strip optional "Cookie:" prefix (case-insensitive)
  let values = headerLine.replace(/^cookie:\s*/i, "").trim();
  const pairs = values.split(/;\s*/);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (ALLOWED_COOKIE_NAMES.has(name)) {
      if (/[\r\n]/.test(value)) {
        process.stderr.write(`cookie '${name}' contains illegal characters (CR/LF)\n`);
        process.exit(2);
      }
      out[name] = value;
    }
  }
}

/**
 * Build a typed cookies object from raw string record.
 * Only known keys survive.
 */
function buildCookies(raw: Record<string, string>): AuthFile["cookies"] {
  const result: AuthFile["cookies"] = {};
  if (raw["PHPSESSID"] !== undefined) result.PHPSESSID = raw["PHPSESSID"];
  if (raw["_identity"] !== undefined) result._identity = raw["_identity"];
  if (raw["_csrf"] !== undefined) result._csrf = raw["_csrf"];
  if (raw["access_token"] !== undefined) result.access_token = raw["access_token"];
  return result;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    const lines: string[] = [];
    rl.on("line", (line) => lines.push(line));
    rl.on("close", () => resolve(lines.join("\n")));
    rl.on("error", reject);
  });
}
