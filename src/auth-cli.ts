#!/usr/bin/env node
/**
 * auth-cli.ts — handles `aiployee-bridge auth --token <value>` (and `--token -` for stdin).
 *
 * Called from mcp-server.ts when process.argv[2] === "auth".
 * Writes ~/.aiployee-bridge/auth.json and prints the resolved path.
 * Exit codes: 0 = success, 2 = argument error.
 */

import { createInterface } from "node:readline";
import { saveAuth } from "./client/auth.js";

export async function runAuthCli(argv: string[]): Promise<void> {
  // argv here is process.argv.slice(3) — everything after "auth"
  let token: string | undefined;
  let apiBase: string | undefined;

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
    }
  }

  if (token === undefined) {
    process.stderr.write(
      "aiployee-bridge auth: missing required argument --token <value>\n" +
        "Usage: aiployee-bridge auth --token <value> [--api-base <url>]\n" +
        "       aiployee-bridge auth --token -  (reads token from stdin)\n",
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

  const p = await saveAuth(token, apiBase);
  process.stdout.write(`Saved auth to: ${p}\n`);
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
