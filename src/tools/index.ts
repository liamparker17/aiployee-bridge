/**
 * tools/index.ts — barrel re-export for the tool-group façade.
 *
 * Library callers: import from "aiployee-bridge/tools" or from the root
 * "aiployee-bridge" entrypoint (which re-exports these symbols).
 */

export type { FlowSummary } from "./flows.js";
export { listFlows, getFlow, updateFlow, validateFlowLocal } from "./flows.js";

export type { AgentSummary, AgentDetails, AgentUpdate } from "./agents.js";
export { listAgents, getAgent, updateAgent } from "./agents.js";

export type { PhoneNumberKind, PhoneNumberInfo } from "./numbers.js";
export { listPhoneNumbers } from "./numbers.js";

export type { CustomFieldDTO, CustomFieldType } from "./custom_fields.js";
export { listCustomFields, upsertCustomField, deleteCustomField } from "./custom_fields.js";

export type { ContactDTO } from "./contacts.js";
export { getContact, updateContactAttribute } from "./contacts.js";
