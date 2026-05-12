/**
 * contacts.ts — thin MCP tool wrappers over the contacts client module.
 */

import type { Client } from "../client/index.js";
import type { ContactDTO } from "../client/contacts.js";

export type { ContactDTO };

/**
 * Get a contact's DTO (top-level fields + Custom Field attribute values).
 * Requires Yii cookies in the auth file.
 */
export function getContact(c: Client, uuid: string): Promise<ContactDTO> {
  return c.getContact(uuid);
}

/**
 * Write a single Custom Field value on a Contact mid-call.
 * Validates slug and value before any network call.
 * Requires Yii cookies in the auth file.
 */
export function updateContactAttribute(
  c: Client,
  args: { contactUuid: string; slug: string; value: string },
): Promise<void> {
  return c.updateContactAttribute(args);
}
