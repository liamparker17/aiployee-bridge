/**
 * contacts.ts — getContact / updateContactAttribute via YiiTransport.
 *
 * DTOs are defined here (co-located with consumption, per bridge style).
 */

import type { Client } from "./index.js";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface ContactDTO {
  uuid: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  timezone: string | null;
  /** Map of Custom Field slug → current value (as the form rendered it). */
  attributes: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SLUG_RE = /^[_a-z][_a-z0-9]*$/;
const CRLF_RE = /[\r\n]/;

function validateArgs(contactUuid: string, slug: string, value: string): void {
  if (!contactUuid) {
    throw new Error("contactUuid must be a non-empty string");
  }
  if (CRLF_RE.test(contactUuid)) {
    throw new Error("contactUuid must not contain CR or LF");
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `slug '${slug}' is invalid — must match ^[_a-z][_a-z0-9]*$`,
    );
  }
  if (CRLF_RE.test(value)) {
    throw new Error("value must not contain CR or LF characters");
  }
}

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

function emptyToNull(s: string): string | null {
  return s === "" ? null : s;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch the SaveCustomerForm for the given contact uuid and return a typed DTO.
 *
 * - Top-level fields: phone, email, name, timezone — empty string becomes null.
 * - attributes: every SaveCustomerForm[values][<slug>] field, keyed by slug.
 */
export async function getContact(
  c: Client,
  uuid: string,
): Promise<ContactDTO> {
  if (CRLF_RE.test(uuid)) {
    throw new Error("uuid must not contain CR or LF");
  }
  const yt = c.yiiTransport;
  const form = await yt.getForm(`/customers/${uuid}/edit`, {
    formId: "save-customer-form",
  });
  const f = form.fields;

  // Extract attributes: every key matching SaveCustomerForm[values][<slug>]
  const attributes: Record<string, string> = {};
  const PREFIX = "SaveCustomerForm[values][";
  const SUFFIX = "]";
  for (const [key, val] of Object.entries(f)) {
    if (key.startsWith(PREFIX) && key.endsWith(SUFFIX)) {
      const slug = key.slice(PREFIX.length, key.length - SUFFIX.length);
      if (slug.length > 0) {
        attributes[slug] = Array.isArray(val) ? val.join("") : val;
      }
    }
  }

  return {
    uuid,
    phone: emptyToNull(str(f, "SaveCustomerForm[phone]")),
    email: emptyToNull(str(f, "SaveCustomerForm[email]")),
    name: emptyToNull(str(f, "SaveCustomerForm[name]")),
    timezone: emptyToNull(str(f, "SaveCustomerForm[timezone]")),
    attributes,
  };
}

/**
 * Write a single Custom Field value on a Contact.
 *
 * Validates before any network call. Fetches the current form, overrides
 * the target attribute field, and submits. Throws YiiFormError on failure.
 *
 * No refetch — mid-call writes are hot-path; caller uses getContact if needed.
 */
export async function updateContactAttribute(
  c: Client,
  args: { contactUuid: string; slug: string; value: string },
): Promise<void> {
  // Validate before any network call
  validateArgs(args.contactUuid, args.slug, args.value);

  const yt = c.yiiTransport;
  const form = await yt.getForm(`/customers/${args.contactUuid}/edit`, {
    formId: "save-customer-form",
  });

  const fieldKey = `SaveCustomerForm[values][${args.slug}]`;
  await yt.submitForm(form, { [fieldKey]: args.value });
}
