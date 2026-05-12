// Yii ActiveForm transport — GET-parse-merge-POST for any Yii form endpoint.
// No DOM library; targeted regex only.

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export interface YiiFormState {
  /** Raw form values keyed by Yii bracket notation, e.g. "AiAgentForm[prompts]". */
  fields: Record<string, string | string[]>;
  /** CSRF token from <meta name="csrf-token"> on the page. */
  csrfToken: string;
  /** Yii's _submission_token form field value (anti-replay nonce). */
  submissionToken: string;
  /** Form action URL as parsed off the <form action="..."> attribute. */
  action: string;
  /** Form method (almost always "POST"). */
  method: string;
}

export interface YiiTransportOptions {
  yiiHost: string;
  cookies: {
    PHPSESSID?: string;
    _identity?: string;
    _csrf?: string;
    access_token?: string;
  };
  /** Optional fetch override for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export class YiiFormError extends Error {
  readonly status: number;
  readonly errors: ExtractedError[];

  constructor(opts: { status: number; errors: ExtractedError[] }) {
    const summary = opts.errors.map((e) => e.message).join("; ");
    super(summary || "form submitted but response page contained no success indicators");
    this.name = "YiiFormError";
    this.status = opts.status;
    this.errors = opts.errors;
  }
}

export interface ExtractedError {
  field?: string;
  message: string;
}

export class YiiTransport {
  private readonly opts: YiiTransportOptions;

  constructor(opts: YiiTransportOptions) {
    // Validate cookie values: reject anything containing CR, LF, or semicolon.
    for (const [name, value] of Object.entries(opts.cookies)) {
      if (value !== undefined && /[\r\n;]/.test(value)) {
        throw new Error(`cookie '${name}' contains illegal characters`);
      }
    }
    this.opts = opts;
  }

  private get fetchImpl(): typeof fetch {
    return this.opts.fetchImpl ?? globalThis.fetch;
  }

  /** Build the Cookie header value from opts.cookies (only present values). */
  private cookieHeader(): string {
    const parts: string[] = [];
    const c = this.opts.cookies;
    if (c.PHPSESSID) parts.push(`PHPSESSID=${c.PHPSESSID}`);
    if (c._identity) parts.push(`_identity=${c._identity}`);
    if (c._csrf) parts.push(`_csrf=${c._csrf}`);
    if (c.access_token) parts.push(`access_token=${c.access_token}`);
    return parts.join("; ");
  }

  /** True when at least one cookie value is present. */
  private hasCookies(): boolean {
    const c = this.opts.cookies;
    return !!(c.PHPSESSID || c._identity || c._csrf || c.access_token);
  }

  /**
   * GET the page and parse the first matching <form> (or the form with formId).
   * Throws when no form is found or cookies are absent.
   */
  async getForm(path: string, opts?: { formId?: string }): Promise<YiiFormState> {
    if (!this.hasCookies()) {
      throw new Error(
        'auth incomplete — Yii cookies not configured; run `aiployee-bridge auth`',
      );
    }

    const url = buildUrl(this.opts.yiiHost, path);
    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Cookie: this.cookieHeader(),
        Accept: "text/html",
      },
      redirect: "follow",
    });

    if (!res.ok) {
      throw new Error(`GET ${url} returned HTTP ${res.status}`);
    }

    const html = await res.text();
    return parseYiiForm(html, opts?.formId);
  }

  /**
   * POST a merged form (urlencoded).
   * Returns { status, finalUrl, html } on 302 success.
   * Throws YiiFormError on 200 (validation failure).
   * Throws Error on anything else.
   */
  async submitForm(
    form: YiiFormState,
    overrides: Record<string, string | string[]>,
  ): Promise<{ status: number; finalUrl: string; html: string }> {
    const merged: Record<string, string | string[]> = {
      ...form.fields,
      ...overrides,
      _submission_token: form.submissionToken,
    };

    const body = encodeFormBody(merged);
    const actionUrl = form.action.startsWith("http")
      ? form.action
      : buildUrl(this.opts.yiiHost, form.action);

    const res = await this.fetchImpl(actionUrl, {
      method: form.method.toUpperCase(),
      headers: {
        Cookie: this.cookieHeader(),
        "X-CSRF-Token": form.csrfToken,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        Referer: this.opts.yiiHost,
      },
      body,
      redirect: "manual",
    });

    if (res.status === 302) {
      const location = res.headers.get("Location") ?? "";
      if (/(^|\?|&)error(=|&|$)/.test(location)) {
        throw new Error(`form POST redirected to error URL: ${location}`);
      }
      return { status: 302, finalUrl: location, html: "" };
    }

    if (res.status === 200) {
      const html = await res.text();
      const errors = extractFormErrors(html);
      throw new YiiFormError({ status: 200, errors });
    }

    throw new Error(`form POST returned unexpected HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildUrl(host: string, path: string): string {
  const base = host.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return base + p;
}

/** Decode the small set of HTML entities the platform actually emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Get the value of a named attribute from a tag's attribute string.
 * Handles both single and double quotes, and attributes without quotes.
 * Returns undefined when the attribute is not present.
 */
function getAttr(attrStr: string, name: string): string | undefined {
  // Match: name="value", name='value', or name=value (no quotes, stops at space/>)
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*?)"|'([^']*?)'|([^\\s/>]*))`, "i");
  const m = re.exec(attrStr);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3] ?? "";
}

/** True if an attribute flag (like `checked`, `selected`) is present. */
function hasFlag(attrStr: string, flag: string): boolean {
  return new RegExp(`(?:^|\\s)${flag}(?:\\s|=|$|/)`, "i").test(attrStr);
}

/**
 * Walk `html` starting at `openIdx` (the `<` of the tag) and return the full
 * attribute string plus the index just past the closing `>` or `/>`.
 * Skips characters inside "..." and '...' so attribute values containing `>`
 * do not terminate the scan early.  Returns null if the tag is malformed
 * (e.g. unclosed before end of string).
 */
function readTagAttrs(
  html: string,
  openIdx: number,
  tagName: string,
): { attrs: string; end: number } | null {
  // Advance past "<tagName"
  const afterTag = openIdx + 1 + tagName.length;
  if (afterTag >= html.length) return null;

  let i = afterTag;
  let inDouble = false;
  let inSingle = false;

  while (i < html.length) {
    const ch = html[i];
    if (inDouble) {
      if (ch === '"') inDouble = false;
    } else if (inSingle) {
      if (ch === "'") inSingle = false;
    } else {
      if (ch === '"') {
        inDouble = true;
      } else if (ch === "'") {
        inSingle = true;
      } else if (ch === ">") {
        // End of tag found
        const attrs = html.slice(afterTag, i);
        return { attrs, end: i + 1 };
      }
    }
    i++;
  }
  return null; // malformed — no closing >
}

/**
 * Parse a Yii ActiveForm page.
 * Finds the target <form> (by formId if given), extracts all inputs.
 */
function parseYiiForm(html: string, formId?: string): YiiFormState {
  // --- CSRF token (quote-aware scan) ---
  let csrfToken = "";
  let searchFrom = 0;
  while (searchFrom < html.length) {
    const metaIdx = html.toLowerCase().indexOf("<meta", searchFrom);
    if (metaIdx === -1) break;
    const parsed = readTagAttrs(html, metaIdx, "meta");
    if (!parsed) { searchFrom = metaIdx + 5; continue; }
    const { attrs, end } = parsed;
    const nameVal = getAttr(attrs, "name");
    if (nameVal?.toLowerCase() === "csrf-token") {
      csrfToken = getAttr(attrs, "content") ?? "";
      break;
    }
    searchFrom = end;
  }

  // Guard against CRLF injection in CSRF token (optional hardening)
  if (csrfToken.includes("\r") || csrfToken.includes("\n")) {
    throw new Error("csrf-token contains CRLF — possible injection; refusing to proceed");
  }

  // --- Locate the form ---
  const formHtml = extractFormHtml(html, formId);
  if (!formHtml) {
    throw new Error(
      formId
        ? `no <form id="${formId}"> found in page`
        : "no <form> found in page",
    );
  }

  // --- Parse form action/method from opening tag ---
  const formTagMatch = /^<form(\s[^>]*)>/i.exec(formHtml);
  const formAttrs = formTagMatch?.[1] ?? "";
  const action = getAttr(formAttrs, "action") ?? "";
  const method = getAttr(formAttrs, "method") ?? "POST";

  // --- Extract all fields ---
  const fields: Record<string, string | string[]> = {};
  let submissionToken = "";

  parseInputs(formHtml, fields);
  parseTextareas(formHtml, fields);
  parseSelects(formHtml, fields);

  // Pull _submission_token out of fields into its own slot
  const raw = fields["_submission_token"];
  if (raw !== undefined && !Array.isArray(raw)) {
    submissionToken = raw;
  }

  return { fields, csrfToken, submissionToken, action, method };
}

/**
 * Slice the HTML from the opening <form> tag to its matching </form>.
 * When formId is given, only match the <form id="..."> with that id.
 */
function extractFormHtml(html: string, formId?: string): string | undefined {
  // Build opener regex
  const openerRe = formId
    ? new RegExp(`<form\\b([^>]*\\bid\\s*=\\s*["']${escapeRegex(formId)}["'][^>]*)>`, "i")
    : /<form\b([^>]*)>/i;

  const openerMatch = openerRe.exec(html);
  if (!openerMatch) return undefined;

  const start = openerMatch.index;
  // Walk forward counting <form> opens/closes to find matching </form>
  let depth = 1;
  let pos = start + openerMatch[0].length;

  while (pos < html.length && depth > 0) {
    const nextOpen = html.indexOf("<form", pos);
    const nextClose = html.toLowerCase().indexOf("</form>", pos);

    if (nextClose === -1) break;

    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 5; // past "<form"
    } else {
      depth--;
      pos = nextClose + 7; // past "</form>"
    }
  }

  return html.slice(start, pos);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse all <input> elements within formHtml and populate fields. */
function parseInputs(formHtml: string, fields: Record<string, string | string[]>): void {
  const lower = formHtml.toLowerCase();
  let searchFrom = 0;

  while (searchFrom < formHtml.length) {
    const inputIdx = lower.indexOf("<input", searchFrom);
    if (inputIdx === -1) break;
    const parsed = readTagAttrs(formHtml, inputIdx, "input");
    if (!parsed) { searchFrom = inputIdx + 6; continue; }
    const { attrs, end } = parsed;
    searchFrom = end;

    const name = getAttr(attrs, "name");
    if (!name) continue;

    const type = (getAttr(attrs, "type") ?? "text").toLowerCase();
    const rawValue = getAttr(attrs, "value") ?? "";
    const value = decodeEntities(rawValue);

    if (type === "checkbox" || type === "radio") {
      if (!hasFlag(attrs, "checked")) continue;
      setField(fields, name, value);
    } else if (type === "submit" || type === "button" || type === "image" || type === "reset") {
      // Don't include button/submit inputs in auto-extracted fields
      continue;
    } else {
      // text, hidden, number, email, password, and no-type inputs
      setField(fields, name, value);
    }
  }
}

/** Parse all <textarea> elements within formHtml. */
function parseTextareas(formHtml: string, fields: Record<string, string | string[]>): void {
  const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  let m: RegExpExecArray | null;

  while ((m = taRe.exec(formHtml)) !== null) {
    const attrs = m[1] ?? "";
    const name = getAttr(attrs, "name");
    if (!name) continue;
    const value = decodeEntities(m[2] ?? "");
    setField(fields, name, value);
  }
}

/** Parse all <select> elements within formHtml. */
function parseSelects(formHtml: string, fields: Record<string, string | string[]>): void {
  const selRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let m: RegExpExecArray | null;

  while ((m = selRe.exec(formHtml)) !== null) {
    const attrs = m[1] ?? "";
    const name = getAttr(attrs, "name");
    if (!name) continue;

    const inner = m[2] ?? "";
    const value = extractSelectedOption(inner);
    if (value !== undefined) {
      setField(fields, name, value);
    }
  }
}

/** Extract the value of the selected option, or first option if none selected. */
function extractSelectedOption(inner: string): string | undefined {
  const optRe = /<option\b([^>]*)>[\s\S]*?(?=<option|<\/select>)/gi;
  let firstValue: string | undefined;
  let m: RegExpExecArray | null;

  // First pass: find selected
  const optRe2 = /<option\b([^>]*)>/gi;
  while ((m = optRe2.exec(inner)) !== null) {
    const attrs = m[1] ?? "";
    const val = getAttr(attrs, "value") ?? "";
    if (firstValue === undefined) firstValue = val;
    if (hasFlag(attrs, "selected")) return val;
  }

  void optRe; // silence unused warning
  return firstValue;
}

/**
 * Set a field value in the fields map.
 * Names ending in `[]` accumulate into string[].
 * All others are stored as string (last writer wins for duplicates without []).
 */
function setField(
  fields: Record<string, string | string[]>,
  name: string,
  value: string,
): void {
  if (name.endsWith("[]")) {
    const existing = fields[name];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      fields[name] = [value];
    }
  } else {
    fields[name] = value;
  }
}

/**
 * Encode a merged fields map as application/x-www-form-urlencoded.
 * Keys like AiAgentForm[prompts] are URL-encoded → AiAgentForm%5Bprompts%5D.
 * Array values ([]  suffix keys) emit one entry per element.
 */
function encodeFormBody(fields: Record<string, string | string[]>): string {
  const parts: string[] = [];

  for (const [key, val] of Object.entries(fields)) {
    const encodedKey = encodeURIComponent(key);
    if (Array.isArray(val)) {
      for (const v of val) {
        parts.push(`${encodedKey}=${encodeURIComponent(v)}`);
      }
    } else {
      parts.push(`${encodedKey}=${encodeURIComponent(val)}`);
    }
  }

  return parts.join("&");
}

/**
 * Extract structured validation errors from a Yii form-error HTML response.
 * Looks for:
 *   - <div class="help-block help-block-error">MSG</div>
 *   - <p class="invalid-feedback ...">MSG</p>
 *   - .has-error containers
 */
function extractFormErrors(html: string): ExtractedError[] {
  const errors: ExtractedError[] = [];

  // Pattern 1: help-block help-block-error (standard Yii ActiveForm)
  const helpRe = /<div\b[^>]*class\s*=\s*["'][^"']*help-block[^"']*help-block-error[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = helpRe.exec(html)) !== null) {
    const msg = stripTags(decodeEntities(m[1] ?? "")).trim();
    if (msg) errors.push({ message: msg });
  }

  // Pattern 2: invalid-feedback (Bootstrap 4+ Yii)
  const fbRe = /<p\b[^>]*class\s*=\s*["'][^"']*invalid-feedback[^"']*["'][^>]*>([\s\S]*?)<\/p>/gi;
  while ((m = fbRe.exec(html)) !== null) {
    const msg = stripTags(decodeEntities(m[1] ?? "")).trim();
    if (msg) errors.push({ message: msg });
  }

  // Pattern 3: has-error containers — grab direct error text within them
  const hasErrRe = /<[^>]+class\s*=\s*["'][^"']*has-error[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p|li)>/gi;
  while ((m = hasErrRe.exec(html)) !== null) {
    const inner = m[1] ?? "";
    // Only extract error text from known sub-elements
    const subRe = /<(?:span|p|div)\b[^>]*>([\s\S]*?)<\/(?:span|p|div)>/gi;
    let sub: RegExpExecArray | null;
    while ((sub = subRe.exec(inner)) !== null) {
      const msg = stripTags(decodeEntities(sub[1] ?? "")).trim();
      if (msg && !errors.some((e) => e.message === msg)) {
        errors.push({ message: msg });
      }
    }
  }

  return errors;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}
