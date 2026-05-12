import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// One token per bridge process. Stored at ~/.aiployee-bridge/auth.json
// with 0600 perms (best-effort on Windows).

export interface AuthFile {
  /** The access_token cookie value copied from a logged-in browser. */
  token: string;
  /** Optional override for the API host; defaults to https://dashboard-api.jobix.ai/v1 */
  apiBase?: string;
  /** When the token was saved, for diagnostics. */
  savedAt: string;
}

export const DEFAULT_API_BASE = "https://dashboard-api.jobix.ai/v1";

export function authPath(): string {
  return path.join(homedir(), ".aiployee-bridge", "auth.json");
}

export async function loadAuth(): Promise<AuthFile> {
  const p = authPath();
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        `auth file not found at ${p} — run \`aiployee-bridge auth --token <value>\` first`,
      );
    }
    throw e;
  }
  const parsed = JSON.parse(raw) as Partial<AuthFile>;
  if (!parsed.token || typeof parsed.token !== "string") {
    throw new Error(`auth file at ${p} is missing "token"`);
  }
  return {
    token: parsed.token,
    savedAt: parsed.savedAt ?? "(unknown)",
    ...(parsed.apiBase ? { apiBase: parsed.apiBase } : {}),
  };
}

export async function saveAuth(token: string, apiBase?: string): Promise<string> {
  const p = authPath();
  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true });
  const payload: AuthFile = {
    token,
    savedAt: new Date().toISOString(),
    ...(apiBase ? { apiBase } : {}),
  };
  await fs.writeFile(p, JSON.stringify(payload, null, 2), { mode: 0o600 });
  try {
    await fs.chmod(p, 0o600);
  } catch {
    // Windows chmod is best-effort; the JSON content itself doesn't leak
    // beyond the user profile so this is acceptable.
  }
  return p;
}
