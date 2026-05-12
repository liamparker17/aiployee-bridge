/**
 * flow_runs.ts — list_flow_runs: scrape /calls (Yii-rendered HTML listing).
 *
 * HTML structure assumptions (as of 2026-05-12 recon):
 *   - The listing is a <table> with a <tbody> where each <tr> is one call record.
 *   - The call UUID lives in an <a href="/calls/<uuid>/details"> link within the row.
 *   - Cell order (0-based, best-guess from recon — adjust if live HTML differs):
 *       0: checkbox / selection (skip)
 *       1: UUID link cell — <a href="/calls/<uuid>/details">
 *       2: status badge — <span class="bg-...">StatusText</span> or plain text
 *       3: channel string — plain text
 *       4: started_at — plain text timestamp
 *       5: duration — plain text like "0:42", "1:30", "45s"
 *       6+: agent / flow references (optional, may contain links)
 *
 * TODO: probe ?flow_uuid=<uuid> query-param filter against the live tenant.
 * For now, /calls is fetched unfiltered and filtered client-side. This is safe
 * because the page only returns the first 25 rows anyway. Pagination is not
 * yet implemented — the bridge surfaces what the first page exposes.
 *
 * If flowUuid is provided and all parsed rows have flowUuid === null (i.e. the
 * page doesn't embed flow-link hrefs), the full unfiltered set is returned with
 * a comment in a log-style warning — no silent drop.
 */

import type { Client } from "./index.js";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface FlowRunSummary {
  uuid: string;
  flowUuid: string | null;
  agentUuid: string | null;
  /** ISO 8601 if parseable from the page, else the raw string the page rendered. */
  startedAt: string;
  durationS: number | null;
  /** Exact string the page renders, snake/lower-cased. e.g. "completed", "transferred", "failed" */
  status: string;
  /** Exact string the page renders. e.g. "inbound_call", "internet_call" */
  channel: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Duration parser
// ---------------------------------------------------------------------------

/**
 * Parse common duration formats into total seconds.
 *
 * Supported:
 *   "0:42"   → 42
 *   "1:30"   → 90
 *   "45s"    → 45
 *   "2m"     → 120
 *   "1m 30s" → 90
 *   "1m30s"  → 90
 *
 * Returns null for unrecognised formats.
 */
export function parseDurationS(raw: string): number | null {
  const s = raw.trim();

  // "M:SS" or "H:MM:SS" — colon-separated
  const colonMatch = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (colonMatch) {
    const a = parseInt(colonMatch[1]!, 10);
    const b = parseInt(colonMatch[2]!, 10);
    const c = colonMatch[3] !== undefined ? parseInt(colonMatch[3], 10) : null;
    if (c !== null) {
      // H:MM:SS
      return a * 3600 + b * 60 + c;
    }
    // M:SS
    return a * 60 + b;
  }

  // Pure seconds: "45s" or "45"
  const secMatch = /^(\d+)s?$/.exec(s);
  if (secMatch) {
    return parseInt(secMatch[1]!, 10);
  }

  // Pure minutes: "2m"
  const minMatch = /^(\d+)m$/.exec(s);
  if (minMatch) {
    return parseInt(minMatch[1]!, 10) * 60;
  }

  // "1m 30s" or "1m30s"
  const minSecMatch = /^(\d+)m\s*(\d+)s$/.exec(s);
  if (minSecMatch) {
    return parseInt(minSecMatch[1]!, 10) * 60 + parseInt(minSecMatch[2]!, 10);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Text utilities
// ---------------------------------------------------------------------------

/** Decode the small set of HTML entities the platform actually emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** Strip all HTML tags from a string, then decode entities and trim. */
function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).trim();
}

/** Attempt to extract an href attribute value from a tag string. */
function extractHref(tagHtml: string): string | null {
  const m = /href\s*=\s*(?:"([^"]*?)"|'([^']*?)'|([^\s>]*))/.exec(tagHtml);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * Extract UUID-like segment from a path like /calls/<uuid>/details or /flows/<uuid>.
 * Returns null if no UUID segment is found.
 */
function uuidFromPath(path: string): string | null {
  const m = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(path);
  return m?.[1] ?? null;
}

/**
 * snake_case a string: lowercase it and replace runs of non-word chars with "_".
 * e.g. "Inbound Call" → "inbound_call", "Completed" → "completed"
 */
function toSnakeCase(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
// HTML row parser
// ---------------------------------------------------------------------------

/**
 * Parse /calls listing HTML into FlowRunSummary rows.
 *
 * Exported for direct unit testing (tests provide inline HTML fixtures).
 */
export function extractFlowRunsFromHtml(html: string): FlowRunSummary[] {
  // Find the <tbody> of the calls table
  const tbodyMatch = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(html);
  if (!tbodyMatch) {
    // No tbody at all — return empty (page may be empty state)
    return [];
  }

  const tbody = tbodyMatch[1]!;

  // Split into individual <tr> blocks
  const rows: string[] = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(tbody)) !== null) {
    rows.push(m[0]!);
  }

  const results: FlowRunSummary[] = [];

  for (const row of rows) {
    // --- Extract call UUID from /calls/<uuid>/details link ---
    const callLinkMatch = /href\s*=\s*["']\/calls\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/details["']/i.exec(row);
    if (!callLinkMatch) {
      // Row doesn't have the expected link — fail loud
      const snippet = row.slice(0, 400);
      throw new Error(`flow run row parse failed; HTML snippet: ${snippet}`);
    }
    const uuid = callLinkMatch[1]!;

    // --- Extract all <td> cell contents ---
    const cells: string[] = [];
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let tdm: RegExpExecArray | null;
    while ((tdm = tdRe.exec(row)) !== null) {
      cells.push(tdm[1]!);
    }

    // --- Extract flowUuid and agentUuid from any /flows/<uuid> or /agents/<uuid> links ---
    let flowUuid: string | null = null;
    let agentUuid: string | null = null;

    // Scan all <a href="..."> in the row for flow/agent paths
    const linkRe = /<a\b[^>]*>/gi;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(row)) !== null) {
      const href = extractHref(lm[0]!);
      if (!href) continue;
      if (/\/flows\//.test(href) && flowUuid === null) {
        flowUuid = uuidFromPath(href);
      }
      if (/\/agents\//.test(href) && agentUuid === null) {
        agentUuid = uuidFromPath(href);
      }
    }

    // --- Extract status: look for a badge span first, fall back to cell text ---
    // The status badge is typically a <span class="bg-...">StatusText</span>
    // We scan cells for a span with a bg- class, or any badge-like span.
    let statusRaw = "";
    const badgeMatch = /<span\b[^>]*class\s*=\s*["'][^"']*bg-[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(row);
    if (badgeMatch) {
      statusRaw = stripHtml(badgeMatch[1]!);
    } else {
      // Fall back: find the first cell that looks like a status string
      // (non-empty, no sub-links, short text)
      for (const cell of cells) {
        const text = stripHtml(cell);
        if (text.length > 0 && text.length < 40 && !/<a\b/.test(cell)) {
          statusRaw = text;
          break;
        }
      }
    }
    const status = toSnakeCase(statusRaw) || "unknown";

    // --- Extract channel, startedAt, duration from cells ---
    // Cell order heuristic: we look for cells containing recognisable patterns.
    // channel: typically "Inbound Call", "Internet Call", "Outbound Call" — matches a keyword
    // startedAt: typically a timestamp string (contains digits + colon + am/pm or ISO)
    // duration: matches M:SS or Ns patterns

    let channel = "unknown";
    let startedAt = "";
    let durationS: number | null = null;

    const CHANNEL_RE = /\b(inbound|outbound|internet|web|sms|email)\b/i;
    const TIMESTAMP_RE = /\d{4}|\d{1,2}:\d{2}\s*(am|pm)/i;
    const DURATION_RE = /^\d+:\d{2}$|^\d+s$|^\d+m(\s*\d+s)?$|^\d+m$/;

    for (const cell of cells) {
      const text = stripHtml(cell);
      if (!text) continue;

      // Skip if it contains the call UUID (that's the link cell)
      if (text.includes(uuid)) continue;

      // Duration: short, matches duration pattern
      if (durationS === null && DURATION_RE.test(text.trim())) {
        durationS = parseDurationS(text);
        continue;
      }

      // Timestamp
      if (!startedAt && TIMESTAMP_RE.test(text) && text.length > 5) {
        startedAt = text;
        continue;
      }

      // Channel: contains channel keyword
      if (channel === "unknown" && CHANNEL_RE.test(text)) {
        channel = toSnakeCase(text);
        continue;
      }
    }

    // Try to normalise startedAt to ISO 8601 if it looks like "2026, May 12 - 9:01 am" or similar
    const isoStartedAt = tryParseIso(startedAt);

    results.push({
      uuid,
      flowUuid,
      agentUuid,
      startedAt: isoStartedAt ?? startedAt,
      durationS,
      status,
      channel,
    });
  }

  return results;
}

/**
 * Attempt to parse a display timestamp into ISO 8601.
 * Returns null if parsing fails; caller should use the raw string.
 *
 * Handles patterns like:
 *   "2026, May 12 - 9:01 am"
 *   "2026-05-12 09:01:00"
 *   "May 12, 2026 9:01 AM"
 */
function tryParseIso(raw: string): string | null {
  if (!raw) return null;

  // Already ISO-like
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) {
    return new Date(raw).toISOString();
  }

  // "2026, May 12 - 9:01 am" → normalise
  const m1 = /^(\d{4}),?\s+([A-Za-z]+)\s+(\d{1,2})\s*[-,]?\s*(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(raw);
  if (m1) {
    const year = m1[1]!;
    const month = m1[2]!;
    const day = m1[3]!;
    const hour = m1[4]!;
    const min = m1[5]!;
    const ampm = (m1[6] ?? "").toLowerCase();
    const candidate = `${day} ${month} ${year} ${hour}:${min} ${ampm || ""}`.trim();
    const d = new Date(candidate);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // "May 12, 2026 9:01 AM"
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString();

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List recent flow runs from the /calls Yii listing page.
 *
 * - Fetches /calls (unfiltered) via YiiTransport.fetchHtml.
 * - Parses the HTML table into FlowRunSummary rows.
 * - Filters client-side by flowUuid when specified AND rows expose flowUuid.
 *   If all parsed rows have flowUuid === null (page doesn't embed flow links),
 *   the full set is returned regardless of args.flowUuid — the caller is warned
 *   via a console.warn (bridge cannot filter what the page doesn't surface).
 * - Applies limit (default 25, max 200) AFTER filtering.
 *
 * TODO: probe ?flow_uuid=<uuid> query-param filter on the live tenant. If the
 * server honours it, switch to `fetchHtml("/calls?flow_uuid=<uuid>")` and drop
 * the client-side filter fallback.
 */
export async function listFlowRuns(
  c: Client,
  args?: { flowUuid?: string; limit?: number },
): Promise<FlowRunSummary[]> {
  const yt = c.yiiTransport;
  const { html } = await yt.fetchHtml("/calls");

  let rows = extractFlowRunsFromHtml(html);

  // Client-side flowUuid filter
  if (args?.flowUuid !== undefined) {
    const target = args.flowUuid;
    const allNull = rows.every((r) => r.flowUuid === null);
    if (allNull && rows.length > 0) {
      // Page doesn't expose flow links — can't filter; return full set with warning
      console.warn(
        `[aiployee-bridge] listFlowRuns: flowUuid filter requested (${target}) but ` +
          "no flow links were found in /calls rows; returning unfiltered set. " +
          "TODO: probe ?flow_uuid= server-side filter.",
      );
    } else {
      rows = rows.filter((r) => r.flowUuid === target);
    }
  }

  // Apply limit
  const limit = Math.min(
    args?.limit !== undefined && args.limit > 0 ? args.limit : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  return rows.slice(0, limit);
}
