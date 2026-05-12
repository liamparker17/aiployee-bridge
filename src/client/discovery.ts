import { Transport } from "./transport.js";

// The `/v1/r/*` "reference" endpoints. Each returns a list of
// `{label, value, ...}` items inside the envelope. Shapes are kept as
// `unknown` here; tool-surface code in `src/tools/` narrows per call.

export interface DropdownOption {
  label: string;
  value: string;
  [k: string]: unknown;
}

export type PhoneNumberPoolType = "inbound_call" | "outbound_call" | "human_agent";

export interface PhoneNumberPoolEntry {
  label: string;
  value: string; // E.164 phone number
  /** Present on `outbound_call`: the agent that owns this number. */
  agent_uuid?: string;
}

export async function listPhoneNumberPool(
  t: Transport,
  type: PhoneNumberPoolType,
): Promise<PhoneNumberPoolEntry[]> {
  const r = await t.request<unknown>({
    method: "GET",
    path: "/r/phone-numbers-pool",
    query: { type },
  });
  return asArrayOfRecord(r) as unknown as PhoneNumberPoolEntry[];
}

export async function listAgentsDropdown(t: Transport): Promise<DropdownOption[]> {
  const r = await t.request<unknown>({
    method: "GET",
    path: "/r/agents-dropdown",
  });
  return asArrayOfRecord(r) as unknown as DropdownOption[];
}

export async function listWidgetsDropdown(t: Transport): Promise<DropdownOption[]> {
  const r = await t.request<unknown>({
    method: "GET",
    path: "/r/widgets-dropdown",
  });
  return asArrayOfRecord(r) as unknown as DropdownOption[];
}

export async function listActionsDropdown(t: Transport): Promise<DropdownOption[]> {
  const r = await t.request<unknown>({
    method: "GET",
    path: "/r/actions-dropdown",
  });
  return asArrayOfRecord(r) as unknown as DropdownOption[];
}

export interface IntegrationsList {
  email: unknown[];
  sms: unknown[];
  llm: unknown[];
  custom: unknown[];
}

export async function listIntegrations(t: Transport): Promise<IntegrationsList> {
  const r = await t.request<unknown>({
    method: "GET",
    path: "/flows/integrations-list",
  });
  if (typeof r !== "object" || r === null) {
    throw new Error("integrations-list returned non-object");
  }
  const o = r as Record<string, unknown>;
  return {
    email: Array.isArray(o.email) ? o.email : [],
    sms: Array.isArray(o.sms) ? o.sms : [],
    llm: Array.isArray(o.llm) ? o.llm : [],
    custom: Array.isArray(o.custom) ? o.custom : [],
  };
}

function asArrayOfRecord(x: unknown): Record<string, unknown>[] {
  if (!Array.isArray(x)) {
    throw new Error("expected array result");
  }
  return x as Record<string, unknown>[];
}
