/**
 * agents.ts — getAgent / updateAgent via YiiTransport.
 *
 * DTOs are defined here (co-located with consumption, per bridge style).
 */

import type { Client } from "./index.js";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface AgentDetails {
  uuid: string;
  name: string;
  mainGoal: string;
  prompts: string;
  openingGreeting: string;
  summaryPrompt: string;
  summaryEnabled: boolean;
  debugPrompt: string;
  debugEnabled: boolean;
  phoneNumbers: string[];
  knowledgeText: string;
  knowledgeWebsites: { url: string }[];
  /** Every other AiAgentForm field — opaque pass-through. */
  raw: Record<string, string | string[]>;
}

export interface AgentUpdate {
  uuid: string;
  name?: string;
  mainGoal?: string;
  prompts?: string;
  openingGreeting?: string;
  summaryPrompt?: string;
  summaryEnabled?: boolean;
  debugPrompt?: string;
  debugEnabled?: boolean;
  phoneNumbers?: string[];
  knowledgeText?: string;
  knowledgeWebsites?: { url: string }[];
  /**
   * Opaque pass-through for AiAgentForm fields the bridge doesn't model
   * (e.g. `{ "AiAgentForm[language]": "en" }`).
   *
   * Keys that correspond to typed properties (uuid, name, mainGoal, etc.) are
   * **rejected** — use the typed property instead. Passing a typed bracket key
   * here throws an Error naming the offending key.
   */
  raw?: Record<string, string | string[]>;
}

// ---------------------------------------------------------------------------
// Field name mappings
// ---------------------------------------------------------------------------

/** The AiAgentForm bracket keys that are "typed" (not passed through in raw). */
const TYPED_KEYS = new Set([
  "AiAgentForm[uuid]",
  "AiAgentForm[name]",
  "AiAgentForm[main_goal]",
  "AiAgentForm[prompts]",
  "AiAgentForm[opening_greeting]",
  "AiAgentForm[summary_prompt]",
  "AiAgentForm[is_summary_prompt]",
  "AiAgentForm[debug_prompt]",
  "AiAgentForm[is_debug_prompt]",
  "AiAgentForm[phone_numbers]",
  "AiAgentForm[knowledge_text]",
  "AiAgentForm[knowledge_websites]",
]);

const MAX_TEXT_LEN = 50_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(
  fields: Record<string, string | string[]>,
  key: string,
): string {
  const v = fields[key];
  if (v === undefined) return "";
  return Array.isArray(v) ? v.join("") : v;
}

function boolField(
  fields: Record<string, string | string[]>,
  key: string,
): boolean {
  return str(fields, key) === "1";
}

function parseJsonArray<T>(raw: string): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as T[];
    return [];
  } catch {
    return [];
  }
}

function assertMaxLen(value: string, field: string): void {
  if (value.length > MAX_TEXT_LEN) {
    throw new Error(
      `${field} exceeds max length ${MAX_TEXT_LEN} (got ${value.length})`,
    );
  }
}

function validatePhoneNumbers(phones: string[]): void {
  for (let i = 0; i < phones.length; i++) {
    const trimmed = phones[i]?.trim() ?? "";
    if (!trimmed.startsWith("+")) {
      throw new Error(
        `phoneNumbers[${i}] must be E.164 (start with '+'); got '${trimmed}'`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the current form state for the given agent uuid and return a typed DTO.
 */
export async function getAgent(
  c: Client,
  uuid: string,
): Promise<AgentDetails> {
  const yt = c.yiiTransport;
  const form = await yt.getForm(`/ai-agent/${uuid}/edit`, {
    formId: "create-agent-form",
  });
  const f = form.fields;

  // Build raw: every key NOT in TYPED_KEYS
  const raw: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(f)) {
    if (!TYPED_KEYS.has(k)) {
      raw[k] = v;
    }
  }

  return {
    uuid: str(f, "AiAgentForm[uuid]") || uuid,
    name: str(f, "AiAgentForm[name]"),
    mainGoal: str(f, "AiAgentForm[main_goal]"),
    prompts: str(f, "AiAgentForm[prompts]"),
    openingGreeting: str(f, "AiAgentForm[opening_greeting]"),
    summaryPrompt: str(f, "AiAgentForm[summary_prompt]"),
    summaryEnabled: boolField(f, "AiAgentForm[is_summary_prompt]"),
    debugPrompt: str(f, "AiAgentForm[debug_prompt]"),
    debugEnabled: boolField(f, "AiAgentForm[is_debug_prompt]"),
    phoneNumbers: parseJsonArray<string>(str(f, "AiAgentForm[phone_numbers]")),
    knowledgeText: str(f, "AiAgentForm[knowledge_text]"),
    knowledgeWebsites: parseJsonArray<{ url: string }>(
      str(f, "AiAgentForm[knowledge_websites]"),
    ),
    raw,
  };
}

/**
 * Read the current form state, apply `update` overrides, validate locally,
 * then POST. Throws `YiiFormError` on server-side validation failure.
 *
 * Local validation runs BEFORE the network GET so invalid input fails fast.
 */
export async function updateAgent(
  c: Client,
  update: AgentUpdate,
): Promise<void> {
  // Local validation — runs before any network call
  if (update.prompts !== undefined) {
    assertMaxLen(update.prompts, "prompts");
  }
  if (update.mainGoal !== undefined) {
    assertMaxLen(update.mainGoal, "mainGoal");
  }
  if (update.openingGreeting !== undefined) {
    assertMaxLen(update.openingGreeting, "openingGreeting");
  }
  if (update.summaryPrompt !== undefined) {
    assertMaxLen(update.summaryPrompt, "summaryPrompt");
  }
  if (update.debugPrompt !== undefined) {
    assertMaxLen(update.debugPrompt, "debugPrompt");
  }
  if (update.knowledgeText !== undefined) {
    assertMaxLen(update.knowledgeText, "knowledgeText");
  }
  if (update.phoneNumbers !== undefined) {
    validatePhoneNumbers(update.phoneNumbers);
  }
  if (update.raw !== undefined) {
    for (const key of Object.keys(update.raw)) {
      if (TYPED_KEYS.has(key)) {
        throw new Error(
          `update.raw cannot override typed field '${key}' — use the typed property instead`,
        );
      }
    }
  }

  const yt = c.yiiTransport;
  const form = await yt.getForm(`/ai-agent/${update.uuid}/edit`, {
    formId: "create-agent-form",
  });

  // Build overrides map
  const overrides: Record<string, string | string[]> = {};

  if (update.name !== undefined) {
    overrides["AiAgentForm[name]"] = update.name;
  }
  if (update.mainGoal !== undefined) {
    overrides["AiAgentForm[main_goal]"] = update.mainGoal;
  }
  if (update.prompts !== undefined) {
    overrides["AiAgentForm[prompts]"] = update.prompts;
  }
  if (update.openingGreeting !== undefined) {
    overrides["AiAgentForm[opening_greeting]"] = update.openingGreeting;
  }
  if (update.summaryPrompt !== undefined) {
    overrides["AiAgentForm[summary_prompt]"] = update.summaryPrompt;
  }
  if (update.summaryEnabled !== undefined) {
    overrides["AiAgentForm[is_summary_prompt]"] = update.summaryEnabled
      ? "1"
      : "0";
  }
  if (update.debugPrompt !== undefined) {
    overrides["AiAgentForm[debug_prompt]"] = update.debugPrompt;
  }
  if (update.debugEnabled !== undefined) {
    overrides["AiAgentForm[is_debug_prompt]"] = update.debugEnabled ? "1" : "0";
  }
  if (update.phoneNumbers !== undefined) {
    overrides["AiAgentForm[phone_numbers]"] = JSON.stringify(
      update.phoneNumbers.map((p) => p.trim()),
    );
  }
  if (update.knowledgeText !== undefined) {
    overrides["AiAgentForm[knowledge_text]"] = update.knowledgeText;
  }
  if (update.knowledgeWebsites !== undefined) {
    overrides["AiAgentForm[knowledge_websites]"] = JSON.stringify(
      update.knowledgeWebsites,
    );
  }
  // raw: merge verbatim — typed keys already rejected above
  if (update.raw !== undefined) {
    Object.assign(overrides, update.raw);
  }

  await yt.submitForm(form, overrides);
}
