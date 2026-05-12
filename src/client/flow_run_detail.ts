/**
 * flow_run_detail.ts — getFlowRun: scrape /calls/<uuid>/details (Yii-rendered HTML).
 *
 * Companion to flow_runs.ts (which implements list_flow_runs). Lives in a
 * separate file so the listing parser and the detail parser can evolve
 * independently.
 *
 * HTML structure assumptions for /calls/<uuid>/details (as of 2026-05-12 recon).
 * The exact structure is unverified against the live tenant. The parser is
 * defensive: it scans for several common patterns and surfaces what it finds.
 * If the page has zero recognisable structure the transcript will be empty.
 *
 * METADATA BLOCK — any of:
 *   <dt>label</dt><dd>value</dd>                    — definition list pattern
 *   <label>label</label><span|div|p>value</...>     — label/value pattern
 *   Keys are snake_cased (e.g. "Started At" → "started_at").
 *
 * TRANSCRIPT SECTION — any of:
 *   Pattern A: elements with data-role="<role>"
 *   Pattern B: elements with class="role-<role>", "message-<role>", or "msg-<role>"
 *   (Pattern A is preferred; Pattern B is tried only if A finds nothing.)
 *
 * NODE PATH — optional:
 *   <table class="node-path|decision-log|run-log"> with rows of 2-3 cells
 *   (dataKey, type, optional outcome). Absent → nodePath field omitted.
 *
 * ECHO FIELDS — uuid, flowUuid, agentUuid, startedAt, durationS, status, channel
 * are extracted from metadata / href links and echoed onto FlowRunDetail.
 */

import type { Client } from "./index.js";
import { parseDurationS, type FlowRunSummary } from "./flow_runs.js";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  /** Normalised role: "agent" | "customer" | "system" (or raw page value). */
  role: string;
  /** Decoded body text of the turn. */
  text: string;
  /** Milliseconds since epoch when the page exposes it. */
  tsMs?: number;
}

export interface NodePathEntry {
  /** Node's data_key (the user-set label) or numeric id, whichever the page exposes. */
  dataKey: string;
  /** Node type, e.g. "filter", "ai_data_generation", "connect_call_agent". */
  type: string;
  /** Branch outcome ("Completed", "Transferred", etc.), if visible. */
  outcome?: string;
}

export interface FlowRunDetail extends FlowRunSummary {
  /** Transcript entries in the order rendered on the page. */
  transcript: TranscriptEntry[];
  /**
   * Per-node fire log. Optional — only present when the platform exposes it.
   * Omitted entirely (not set to []) when no node-path block is found.
   */
  nodePath?: NodePathEntry[];
  /** Free-form metadata block from the top of the detail page. */
  metadata: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Local helpers (intentionally co-located; private helpers in flow_runs.ts
// are not re-exported, so we duplicate the small set we need here)
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).trim();
}

function extractHref(tagHtml: string): string | null {
  const m = /href\s*=\s*(?:"([^"]*?)"|'([^']*?)'|([^\s>]*))/.exec(tagHtml);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function uuidFromPath(path: string): string | null {
  const m =
    /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(path);
  return m?.[1] ?? null;
}

function toSnakeCase(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
// HTML parser
// ---------------------------------------------------------------------------

/**
 * Parse a /calls/<uuid>/details HTML page into FlowRunDetail.
 *
 * Exported for direct unit testing (tests provide inline HTML fixtures).
 * The passed-in uuid is echoed onto the DTO.
 */
export function extractFlowRunDetailFromHtml(
  uuid: string,
  html: string,
): FlowRunDetail {
  // --- metadata extraction ---
  const metadata: Record<string, string> = {};

  // Pattern 1: <dt>label</dt><dd>value</dd>
  const dlRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi;
  let dm: RegExpExecArray | null;
  while ((dm = dlRe.exec(html)) !== null) {
    const key = toSnakeCase(stripHtml(dm[1]!));
    const value = stripHtml(dm[2]!);
    if (key && value) metadata[key] = value;
  }

  // Pattern 2: <label>label</label> followed by <span|div|p>value</...>
  const labelRe =
    /<label\b[^>]*>([\s\S]*?)<\/label>\s*<(?:span|div|p)\b[^>]*>([\s\S]*?)<\/(?:span|div|p)>/gi;
  let lm: RegExpExecArray | null;
  while ((lm = labelRe.exec(html)) !== null) {
    const key = toSnakeCase(stripHtml(lm[1]!));
    const value = stripHtml(lm[2]!);
    if (key && value && !(key in metadata)) metadata[key] = value;
  }

  // --- summary fields derived from metadata ---
  const status = metadata["status"] ?? "unknown";
  const channel =
    toSnakeCase(metadata["channel"] ?? metadata["call_type"] ?? "") || "unknown";
  const startedAtRaw =
    metadata["started_at"] ??
    metadata["start_time"] ??
    metadata["created_at"] ??
    "";
  const durationRaw = metadata["duration"] ?? metadata["call_duration"] ?? "";
  const durationS = durationRaw ? parseDurationS(durationRaw) : null;

  // --- flowUuid / agentUuid from any /flows/<uuid> or /agents/<uuid> links ---
  let flowUuid: string | null = null;
  let agentUuid: string | null = null;
  const linkRe = /<a\b[^>]*>/gi;
  let lk: RegExpExecArray | null;
  while ((lk = linkRe.exec(html)) !== null) {
    const href = extractHref(lk[0]!);
    if (!href) continue;
    if (flowUuid === null && /\/flows\//.test(href)) flowUuid = uuidFromPath(href);
    if (agentUuid === null && /\/agents\//.test(href)) agentUuid = uuidFromPath(href);
  }

  // --- transcript ---
  const transcript: TranscriptEntry[] = [];

  // Pattern A: data-role="<role>" containers (preferred).
  //
  // TODO(live-fixture): the closing `</[a-z]+>` matches the FIRST closing tag
  // of any element, not necessarily the one that opened the data-role
  // container. A turn body containing nested inline tags (<span>, <em>, <br>)
  // will close on the nested tag, truncating the captured text. Acceptable
  // for the first live fixture pass; tighten with a non-greedy tag-balanced
  // matcher (or DOM-aware parser) once we see real transcript HTML.
  const dataRoleRe =
    /<[a-z]+\b[^>]*\bdata-role\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/[a-z]+>/gi;
  let dr: RegExpExecArray | null;
  while ((dr = dataRoleRe.exec(html)) !== null) {
    const role = dr[1]!.toLowerCase().trim();
    const text = stripHtml(dr[2]!);
    if (text) transcript.push({ role, text });
  }

  // Pattern B: class="(role|message|msg)-<role>" containers (fallback when A finds nothing)
  if (transcript.length === 0) {
    const classRoleRe =
      /<[a-z]+\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:role-|message-|msg-)(agent|customer|system|user|bot|caller)[^"']*["'][^>]*>([\s\S]*?)<\/[a-z]+>/gi;
    let cr: RegExpExecArray | null;
    while ((cr = classRoleRe.exec(html)) !== null) {
      const role = cr[1]!.toLowerCase();
      const text = stripHtml(cr[2]!);
      if (text) transcript.push({ role, text });
    }
  }

  if (transcript.length === 0) {
    // Warn but don't throw — empty transcript is legitimate for hangups / in-progress sessions.
    console.warn(
      "[aiployee-bridge] extractFlowRunDetailFromHtml: no transcript elements found " +
        "(patterns tried: data-role attribute, class=role-*/message-*/msg-* prefix). " +
        "Expected for very-short calls or in-progress sessions. " +
        "Re-run Task 7.5 live integration if you expected a transcript.",
    );
  }

  // --- nodePath (optional) ---
  let nodePath: NodePathEntry[] | undefined;
  const nodeTableMatch =
    /<table\b[^>]*\bclass\s*=\s*["'][^"']*\b(?:node-path|decision-log|run-log)\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i.exec(
      html,
    );
  if (nodeTableMatch) {
    const inner = nodeTableMatch[1]!;
    const rows: NodePathEntry[] = [];
    const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr: RegExpExecArray | null;
    while ((tr = trRe.exec(inner)) !== null) {
      const cells: string[] = [];
      const tdRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let td: RegExpExecArray | null;
      while ((td = tdRe.exec(tr[1]!)) !== null) {
        cells.push(stripHtml(td[1]!));
      }
      if (cells.length >= 2 && cells[0] && cells[1]) {
        const entry: NodePathEntry = { dataKey: cells[0], type: cells[1] };
        if (cells[2]) entry.outcome = cells[2];
        rows.push(entry);
      }
    }
    if (rows.length > 0) nodePath = rows;
  }

  const result: FlowRunDetail = {
    uuid,
    flowUuid,
    agentUuid,
    startedAt: startedAtRaw,
    durationS,
    status: toSnakeCase(status) || "unknown",
    channel,
    transcript,
    metadata,
  };
  if (nodePath !== undefined) {
    result.nodePath = nodePath;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the full detail for a flow run (call record) by its UUID.
 *
 * Fetches /calls/<uuid>/details via the Yii session and parses the HTML.
 * Throws on empty/CRLF UUID before any network call.
 */
export async function getFlowRun(c: Client, uuid: string): Promise<FlowRunDetail> {
  if (!uuid || uuid.trim().length === 0) {
    throw new Error("getFlowRun: uuid must be a non-empty string");
  }
  if (/[\r\n]/.test(uuid)) {
    throw new Error("getFlowRun: uuid contains illegal characters (CR/LF)");
  }

  const yt = c.yiiTransport;
  const { html } = await yt.fetchHtml(`/calls/${uuid}/details`);
  return extractFlowRunDetailFromHtml(uuid, html);
}
