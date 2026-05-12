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
  /** Yii host; defaults to https://aiployee.jobix.ai when absent. */
  yiiHost?: string;
  /** Yii session cookies. When absent, Yii-form features (Agents, Custom Fields, Contacts) are unavailable. */
  cookies?: {
    PHPSESSID?: string;
    _identity?: string;
    _csrf?: string;
    access_token?: string;
  };
  /** When the token was saved, for diagnostics. */
  savedAt: string;
}

export const DEFAULT_API_BASE = "https://dashboard-api.jobix.ai/v1";
export const DEFAULT_YII_HOST = "https://aiployee.jobix.ai";

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
  const result: AuthFile = {
    token: parsed.token,
    savedAt: parsed.savedAt ?? "(unknown)",
    ...(parsed.apiBase ? { apiBase: parsed.apiBase } : {}),
    ...(parsed.yiiHost ? { yiiHost: parsed.yiiHost } : {}),
    ...(parsed.cookies ? { cookies: parsed.cookies } : {}),
  };
  return result;
}

export async function saveAuth(opts: {
  token: string;
  apiBase?: string;
  yiiHost?: string;
  cookies?: AuthFile["cookies"];
}): Promise<string> {
  const { token, apiBase, yiiHost, cookies } = opts;
  const p = authPath();
  const dir = path.dirname(p);
  await fs.mkdir(dir, { recursive: true });
  const payload: AuthFile = {
    token,
    savedAt: new Date().toISOString(),
    ...(apiBase ? { apiBase } : {}),
    ...(yiiHost ? { yiiHost } : {}),
    ...(cookies ? { cookies } : {}),
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
