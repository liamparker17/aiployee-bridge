import { ApiError } from "../schema/envelope.js";

// Universal request wrapper. Adds bearer auth, sends/receives JSON,
// unwraps the JSend envelope, and throws ApiError when success===false
// or HTTP indicates a transport failure.

export interface TransportOptions {
  apiBase: string;
  token: string;
  /** Logger hook — fires before every request. Default: no-op. */
  onRequest?: (info: { method: string; url: string; body?: unknown }) => void;
  /** Optional fetch override for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string; // e.g. "/flows/<uuid>/nodes"
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Timeout in ms. Default 30s. */
  timeoutMs?: number;
}

export class Transport {
  constructor(private readonly opts: TransportOptions) {}

  get token(): string { return this.opts.token; }
  get fetchImpl(): typeof fetch { return this.opts.fetchImpl ?? globalThis.fetch; }

  async request<T = unknown>(req: RequestOptions): Promise<T> {
    const url = this.buildUrl(req.path, req.query);
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 30_000);

    this.opts.onRequest?.({ method: req.method, url, body: req.body });

    let res: Response;
    try {
      const f = this.opts.fetchImpl ?? globalThis.fetch;
      res = await f(url, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${this.opts.token}`,
          Accept: "application/json",
          ...(req.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        signal: ctrl.signal,
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      throw new ApiError({
        message: `non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`,
        endpoint: `${req.method} ${url}`,
        httpStatus: res.status,
        code: res.status,
        errors: text.slice(0, 2000),
      });
    }

    // Some endpoints (auth failures, gateway errors) may not return the
    // envelope. Surface them with the raw body as `errors`.
    if (!isEnvelope(parsed)) {
      throw new ApiError({
        message: `unexpected response shape (HTTP ${res.status})`,
        endpoint: `${req.method} ${url}`,
        httpStatus: res.status,
        code: res.status,
        errors: parsed,
      });
    }

    if (parsed.success !== true) {
      throw new ApiError({
        message: formatErrorMessage(parsed.errors) ?? `request failed (code ${parsed.code})`,
        endpoint: `${req.method} ${url}`,
        httpStatus: res.status,
        code: parsed.code,
        errors: parsed.errors,
      });
    }

    return parsed.result as T;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const base = this.opts.apiBase.replace(/\/+$/, "");
    const p = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(base + p);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

function isEnvelope(x: unknown): x is {
  code: number;
  success: boolean;
  errors: unknown;
  result: unknown;
} {
  return (
    typeof x === "object" &&
    x !== null &&
    "success" in x &&
    "code" in x &&
    "errors" in x &&
    "result" in x
  );
}

function formatErrorMessage(errors: unknown): string | undefined {
  if (errors == null) return undefined;
  if (typeof errors === "string") return errors;
  if (Array.isArray(errors)) {
    const msgs = errors
      .map((e) => (typeof e === "string" ? e : tryExtractMessage(e)))
      .filter(Boolean);
    if (msgs.length > 0) return msgs.join("; ");
  }
  if (typeof errors === "object") {
    const msg = tryExtractMessage(errors);
    if (msg) return msg;
  }
  return JSON.stringify(errors).slice(0, 300);
}

function tryExtractMessage(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const o = e as Record<string, unknown>;
  if (typeof o.message === "string") return o.message;
  if (typeof o.error === "string") return o.error;
  return undefined;
}
