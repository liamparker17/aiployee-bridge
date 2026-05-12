/**
 * custom_fields.ts — listCustomFields / upsertCustomField / deleteCustomField
 * via bulk YiiTransport read-modify-write on /management/customer-fields.
 *
 * The platform form key prefix is:
 *   UpdateOrCreateCustomerFieldForm[fields][<i>][uuid|name|type|slug|description]
 *
 * All bracket notation is kept inside this module; callers see only DTOs.
 */

import type { Client } from "./index.js";
import type { YiiFormState } from "./yii.js";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type CustomFieldType =
  | "string"
  | "integer"
  | "float"
  | "boolean"
  | "date"
  | "array";

export const CUSTOM_FIELD_TYPES: readonly CustomFieldType[] = [
  "string",
  "integer",
  "float",
  "boolean",
  "date",
  "array",
] as const;

export interface CustomFieldDTO {
  /** null for inserts; assigned by server on first save. */
  uuid: string | null;
  name: string;
  /** Verified enum — string|integer|float|boolean|date|array. */
  type: CustomFieldType;
  /** The `{{ attributes.<slug> }}` template key. */
  slug: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const FORM_PATH = "/management/customer-fields";
const FORM_ID = "fields-form";
const PREFIX = "UpdateOrCreateCustomerFieldForm[fields]";
const MAX_FIELDS = 225;
const SLUG_PATTERN = /^[_a-z][_a-z0-9]*$/;
const ROW_KEYS = ["uuid", "name", "type", "slug", "description"] as const;
type RowKey = (typeof ROW_KEYS)[number];

// ---------------------------------------------------------------------------
// Helpers — field key builders
// ---------------------------------------------------------------------------

function rowKey(i: number, k: RowKey): string {
  return `${PREFIX}[${i}][${k}]`;
}

/**
 * Extract all row DTOs from a parsed form.
 * Returns [maxIndex, rows] where maxIndex is the highest observed index
 * (-1 when there are no rows).
 */
function extractRows(
  fields: Record<string, string | string[]>,
): { maxIndex: number; rows: CustomFieldDTO[] } {
  // Collect row indices from uuid keys
  const indexSet = new Set<number>();
  const pattern = /^UpdateOrCreateCustomerFieldForm\[fields\]\[(\d+)\]\[uuid\]$/;
  for (const key of Object.keys(fields)) {
    const m = pattern.exec(key);
    if (m) {
      indexSet.add(parseInt(m[1]!, 10));
    }
  }

  const indices = [...indexSet].sort((a, b) => a - b);
  const rows: CustomFieldDTO[] = [];
  let maxIndex = 0;

  for (const i of indices) {
    if (i > maxIndex) maxIndex = i;

    const raw = (k: RowKey): string => {
      const v = fields[rowKey(i, k)];
      if (v === undefined) return "";
      return Array.isArray(v) ? v[0] ?? "" : v;
    };

    const typeRaw = raw("type");
    if (!isCustomFieldType(typeRaw)) {
      throw new Error(
        `listCustomFields: schema drift — row index ${i} has type="${typeRaw}" which is not in the verified enum [${CUSTOM_FIELD_TYPES.join(", ")}]`,
      );
    }

    const uuidRaw = raw("uuid");
    rows.push({
      uuid: uuidRaw === "" ? null : uuidRaw,
      name: raw("name"),
      type: typeRaw,
      slug: raw("slug"),
      description: raw("description"),
    });
  }

  return { maxIndex, rows };
}

function isCustomFieldType(v: string): v is CustomFieldType {
  return (CUSTOM_FIELD_TYPES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateDto(dto: CustomFieldDTO): void {
  if (!SLUG_PATTERN.test(dto.slug)) {
    throw new Error(
      `upsertCustomField: invalid slug "${dto.slug}" — must match /^[_a-z][_a-z0-9]*$/`,
    );
  }
  if (!isCustomFieldType(dto.type)) {
    throw new Error(
      `upsertCustomField: invalid type "${dto.type}" — must be one of [${CUSTOM_FIELD_TYPES.join(", ")}]`,
    );
  }
  if (dto.name.length === 0) {
    throw new Error(`upsertCustomField: name must not be empty`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * GET the bulk form and return all Custom Field rows as typed DTOs.
 * Throws if any row has a type outside the verified enum (schema drift).
 */
export async function listCustomFields(c: Client): Promise<CustomFieldDTO[]> {
  const yt = c.yiiTransport;
  const form = await yt.getForm(FORM_PATH, { formId: FORM_ID });
  const { rows } = extractRows(form.fields);
  return rows;
}

/**
 * GET, find/create a row, POST the merged form back.
 * Returns the saved row by re-fetching via listCustomFields.
 *
 * Match order:
 *  1. uuid (when dto.uuid is not null)
 *  2. slug
 *
 * On miss: append a new row at maxIndex+1 with uuid="" (insert).
 */
export async function upsertCustomField(
  c: Client,
  dto: CustomFieldDTO,
): Promise<CustomFieldDTO> {
  // Local validation — runs BEFORE any network call
  validateDto(dto);

  const yt = c.yiiTransport;
  const form = await yt.getForm(FORM_PATH, { formId: FORM_ID });
  const { maxIndex, rows } = extractRows(form.fields);

  // Find matching row index
  let targetIndex: number | null = null;

  if (dto.uuid !== null) {
    // Prefer uuid match
    for (const row of rows) {
      if (row.uuid === dto.uuid) {
        // Recover the index for this row
        targetIndex = findRowIndex(form.fields, "uuid", dto.uuid);
        break;
      }
    }
  }

  if (targetIndex === null) {
    // Fall back to slug match
    targetIndex = findRowIndex(form.fields, "slug", dto.slug);
  }

  const isInsert = targetIndex === null;
  const overrides: Record<string, string | string[]> = {};

  if (isInsert) {
    // Cap check must happen after the GET because the cap depends on current row count.
    if (rows.length >= MAX_FIELDS) {
      throw new Error(
        `upsertCustomField: inserting this row would exceed the platform cap of ${MAX_FIELDS} Custom Fields (currently ${rows.length})`,
      );
    }
    const newIndex = maxIndex + 1;
    overrides[rowKey(newIndex, "uuid")] = "";
    overrides[rowKey(newIndex, "name")] = dto.name;
    overrides[rowKey(newIndex, "type")] = dto.type;
    overrides[rowKey(newIndex, "slug")] = dto.slug;
    overrides[rowKey(newIndex, "description")] = dto.description;
  } else {
    // Update in-place — preserve existing uuid
    const existingUuid = ((): string => {
      const v = form.fields[rowKey(targetIndex!, "uuid")];
      if (v === undefined) return "";
      return Array.isArray(v) ? v[0] ?? "" : v;
    })();

    overrides[rowKey(targetIndex!, "uuid")] = existingUuid;
    overrides[rowKey(targetIndex!, "name")] = dto.name;
    overrides[rowKey(targetIndex!, "type")] = dto.type;
    overrides[rowKey(targetIndex!, "slug")] = dto.slug;
    overrides[rowKey(targetIndex!, "description")] = dto.description;
  }

  await yt.submitForm(form, overrides);

  // Re-fetch to get the server-assigned uuid (for inserts) and confirm save
  const after = await listCustomFields(c);
  const saved = after.find((r) => r.slug === dto.slug);
  if (!saved) {
    throw new Error(
      `upsertCustomField: slug "${dto.slug}" is not present after refetch — the server may have silently rejected the form. Check for validation errors at /management/customer-fields.`,
    );
  }
  return saved;
}

/**
 * GET the bulk form, remove the matching row, POST the modified form.
 * "Omit the row" delete convention: remove the row's 5 bracket keys from
 * the form before submitting so Yii treats it as a deletion.
 *
 * Exactly one of `slug` or `uuid` must be provided.
 */
export async function deleteCustomField(
  c: Client,
  key: { slug?: string; uuid?: string },
): Promise<void> {
  const hasSlug = key.slug !== undefined && key.slug !== "";
  const hasUuid = key.uuid !== undefined && key.uuid !== "";

  if (!hasSlug && !hasUuid) {
    throw new Error(
      `deleteCustomField: either slug or uuid must be provided`,
    );
  }
  if (hasSlug && hasUuid) {
    throw new Error(
      `deleteCustomField: provide either slug OR uuid, not both`,
    );
  }

  const yt = c.yiiTransport;
  const form = await yt.getForm(FORM_PATH, { formId: FORM_ID });

  // Find target row index
  const targetIndex = hasUuid
    ? findRowIndex(form.fields, "uuid", key.uuid!)
    : findRowIndex(form.fields, "slug", key.slug!);

  if (targetIndex === null) {
    // Row not found — treat as already deleted (idempotent)
    return;
  }

  // Slug for error reporting
  const targetSlug = hasSlug
    ? key.slug!
    : (() => {
        const v = form.fields[rowKey(targetIndex, "slug")];
        return v === undefined ? "" : Array.isArray(v) ? (v[0] ?? "") : v;
      })();

  // Build a shallow copy of form.fields with the row's 5 keys removed
  const modifiedFields: Record<string, string | string[]> = { ...form.fields };
  for (const k of ROW_KEYS) {
    delete modifiedFields[rowKey(targetIndex, k)];
  }

  const modifiedForm: YiiFormState = { ...form, fields: modifiedFields };

  // Submit with empty overrides — the row keys are already absent
  await yt.submitForm(modifiedForm, {});

  // Confirm deletion
  const after = await listCustomFields(c);
  const stillPresent = after.find((r) =>
    hasUuid ? r.uuid === key.uuid : r.slug === key.slug,
  );
  if (stillPresent) {
    throw new Error(
      `deleteCustomField: row still present after submit — the omit-row delete convention may not be correct; recon needed. Slug: ${targetSlug}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scan form.fields for a row whose `fieldName` matches `value`.
 * Returns the numeric index, or null if not found.
 */
function findRowIndex(
  fields: Record<string, string | string[]>,
  fieldName: RowKey,
  value: string,
): number | null {
  const pattern = new RegExp(
    `^UpdateOrCreateCustomerFieldForm\\[fields\\]\\[(\\d+)\\]\\[${fieldName}\\]$`,
  );
  for (const [k, v] of Object.entries(fields)) {
    const m = pattern.exec(k);
    if (!m) continue;
    const fieldVal = Array.isArray(v) ? (v[0] ?? "") : v;
    if (fieldVal === value) {
      return parseInt(m[1]!, 10);
    }
  }
  return null;
}
