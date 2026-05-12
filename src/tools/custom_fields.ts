/**
 * custom_fields.ts — thin MCP tool wrappers over the custom_fields client module.
 */

import type { Client } from "../client/index.js";
import type { CustomFieldDTO } from "../client/custom_fields.js";
export type { CustomFieldDTO };
export type { CustomFieldType } from "../client/custom_fields.js";

/**
 * List all Custom Fields (schema rows) for the tenant.
 * Requires Yii cookies in the auth file.
 */
export function listCustomFields(c: Client): Promise<CustomFieldDTO[]> {
  return c.listCustomFields();
}

/**
 * Create or update a Custom Field by slug (or uuid when present).
 * Requires Yii cookies in the auth file.
 */
export function upsertCustomField(
  c: Client,
  dto: CustomFieldDTO,
): Promise<CustomFieldDTO> {
  return c.upsertCustomField(dto);
}

/**
 * Delete a Custom Field by slug or uuid.
 * Exactly one of `slug` or `uuid` must be provided.
 * Requires Yii cookies in the auth file.
 */
export function deleteCustomField(
  c: Client,
  key: { slug?: string; uuid?: string },
): Promise<void> {
  return c.deleteCustomField(key);
}
