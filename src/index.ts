// Library entrypoint. Re-exports the client and schema. MCP wrapping
// lives in src/mcp-server.ts (Phase 4) and is intentionally kept out
// of the library bundle so the client can be used standalone.

export { Client } from "./client/index.js";
export type {
  ClientOptions,
  DropdownOption,
  IntegrationsList,
  PhoneNumberPoolEntry,
  PhoneNumberPoolType,
} from "./client/index.js";
export { DEFAULT_API_BASE, authPath, loadAuth, saveAuth } from "./client/auth.js";
export type { AuthFile } from "./client/auth.js";
export { ApiError } from "./schema/envelope.js";
export * from "./schema/index.js";
