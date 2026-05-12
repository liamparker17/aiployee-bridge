/**
 * custom_fields.test.ts — unit tests for listCustomFields / upsertCustomField / deleteCustomField.
 *
 * Uses inline HTML fixtures and a stubbed YiiTransport (via fetchImpl injection).
 * No live network calls.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { YiiTransport } from "../src/client/yii.js";
import {
  listCustomFields,
  upsertCustomField,
  deleteCustomField,
} from "../src/client/custom_fields.js";
import type { Client } from "../src/client/index.js";
import type { CustomFieldDTO } from "../src/client/custom_fields.js";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function fieldRow(i: number, uuid: string, name: string, type: string, slug: string, description: string): string {
  return `
  <input type="hidden" name="UpdateOrCreateCustomerFieldForm[fields][${i}][uuid]" value="${uuid}">
  <input type="text"   name="UpdateOrCreateCustomerFieldForm[fields][${i}][name]" value="${name}">
  <input type="text"   name="UpdateOrCreateCustomerFieldForm[fields][${i}][type]" value="${type}">
  <input type="text"   name="UpdateOrCreateCustomerFieldForm[fields][${i}][slug]" value="${slug}">
  <input type="text"   name="UpdateOrCreateCustomerFieldForm[fields][${i}][description]" value="${description}">`;
}

function buildForm(rows: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta name="csrf-token" content="csrf-cf-test"></head>
<body>
<form id="fields-form" action="/management/customer-fields" method="POST">
  <input type="hidden" name="_submission_token" value="sub-tok-cf-1">
  ${rows}
</form>
</body>
</html>`;
}

/** 3-row fixture covering string, integer, boolean */
const THREE_ROW_HTML = buildForm(
  fieldRow(0, "uuid-0000-0000-0000-000000000001", "Call Intent",  "string",  "call_intent",  "The detected intent") +
  fieldRow(1, "uuid-0000-0000-0000-000000000002", "Party Size",   "integer", "party_size",   "Number of guests") +
  fieldRow(2, "uuid-0000-0000-0000-000000000003", "Is VIP",       "boolean", "is_vip",       ""),
);

/** 2-row fixture used as base for upsert tests */
const TWO_ROW_HTML = buildForm(
  fieldRow(0, "uuid-aaaa-0000-0000-000000000001", "Active Skill",  "string",  "active_skill",  "Current routing skill") +
  fieldRow(1, "uuid-bbbb-0000-0000-000000000002", "Routing Conf",  "float",   "routing_conf",  "Confidence score"),
);

/** 2-row fixture with "existing" slug for update-by-slug test */
const EXISTING_SLUG_HTML = buildForm(
  fieldRow(0, "uuid-cccc-0000-0000-000000000001", "Old Name",  "string",  "existing",  "original description") +
  fieldRow(1, "uuid-dddd-0000-0000-000000000002", "Other",     "date",    "other",     "another field"),
);

/** 225-row fixture to test cap enforcement */
function buildCapHtml(): string {
  let rows = "";
  for (let i = 0; i < 225; i++) {
    rows += fieldRow(i, `uuid-cap-${String(i).padStart(4, "0")}`, `Field ${i}`, "string", `field_${i}`, "");
  }
  return buildForm(rows);
}
const CAP_HTML = buildCapHtml();

/** Unknown type fixture */
const UNKNOWN_TYPE_HTML = buildForm(
  fieldRow(0, "uuid-zorp-0001", "Zorpian", "zorp", "zorpy", "bad type"),
);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fakeResponse(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html", ...headers },
  });
}

function makeClient(fetchImpl: typeof fetch): Client {
  const yt = new YiiTransport({
    yiiHost: "https://aiployee.jobix.ai",
    cookies: { PHPSESSID: "sess-test", _identity: "id-test", _csrf: "csrf-test" },
    fetchImpl,
  });
  const c = {
    yiiTransport: yt,
    listCustomFields() { return listCustomFields(c as unknown as Client); },
    upsertCustomField(dto: CustomFieldDTO) { return upsertCustomField(c as unknown as Client, dto); },
    deleteCustomField(key: { slug?: string; uuid?: string }) { return deleteCustomField(c as unknown as Client, key); },
  };
  return c as unknown as Client;
}

// ---------------------------------------------------------------------------
// Test 1: listCustomFields parses a multi-row fixture
// ---------------------------------------------------------------------------

describe("listCustomFields — multi-row parse", () => {
  it("returns 3 rows with correct uuids, names, types, slugs, descriptions in order", async () => {
    const c = makeClient(async () => fakeResponse(THREE_ROW_HTML));
    const rows = await listCustomFields(c);

    assert.equal(rows.length, 3);

    assert.deepStrictEqual(rows[0], {
      uuid: "uuid-0000-0000-0000-000000000001",
      name: "Call Intent",
      type: "string",
      slug: "call_intent",
      description: "The detected intent",
    });
    assert.deepStrictEqual(rows[1], {
      uuid: "uuid-0000-0000-0000-000000000002",
      name: "Party Size",
      type: "integer",
      slug: "party_size",
      description: "Number of guests",
    });
    assert.deepStrictEqual(rows[2], {
      uuid: "uuid-0000-0000-0000-000000000003",
      name: "Is VIP",
      type: "boolean",
      slug: "is_vip",
      description: "",
    });
  });
});

// ---------------------------------------------------------------------------
// Test 2: listCustomFields rejects unknown type
// ---------------------------------------------------------------------------

describe("listCustomFields — unknown type", () => {
  it("throws naming the bad type value", async () => {
    const c = makeClient(async () => fakeResponse(UNKNOWN_TYPE_HTML));
    await assert.rejects(
      () => listCustomFields(c),
      (err: Error) => {
        assert.ok(err.message.includes("zorp"), `expected 'zorp' in message: ${err.message}`);
        assert.ok(err.message.includes("schema drift") || err.message.includes("type="), `expected context: ${err.message}`);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Test 3: upsertCustomField — insert
// ---------------------------------------------------------------------------

describe("upsertCustomField — insert new row", () => {
  it("POSTs new row at index 2 with empty uuid; refetch returns the new row", async () => {
    let callCount = 0;
    let capturedBody = "";

    // After the POST we return a 302, then the second GET (for listCustomFields refetch)
    // returns a 3-row fixture including the new row.
    const refetchHtml = buildForm(
      fieldRow(0, "uuid-aaaa-0000-0000-000000000001", "Active Skill", "string", "active_skill", "Current routing skill") +
      fieldRow(1, "uuid-bbbb-0000-0000-000000000002", "Routing Conf",  "float",  "routing_conf",  "Confidence score") +
      fieldRow(2, "uuid-new-000000000001",             "New Field",    "date",   "new_field",     "freshly inserted"),
    );

    const fetchImpl: typeof fetch = async (input, init) => {
      callCount++;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        capturedBody = (init?.body as string) ?? "";
        return new Response("", {
          status: 302,
          headers: { Location: "/management/customer-fields" },
        });
      }
      // GET 1 = initial form, GET 2 = refetch
      if (callCount <= 2) {
        return fakeResponse(TWO_ROW_HTML);
      }
      return fakeResponse(refetchHtml);
    };

    const c = makeClient(fetchImpl);
    const result = await upsertCustomField(c, {
      uuid: null,
      name: "New Field",
      type: "date",
      slug: "new_field",
      description: "freshly inserted",
    });

    const params = new URLSearchParams(capturedBody);

    // New row at index 2 (maxIndex was 1)
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][2][uuid]"), "");
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][2][name]"), "New Field");
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][2][type]"), "date");
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][2][slug]"), "new_field");
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][2][description]"), "freshly inserted");

    // Returned DTO should match the refetched row
    assert.equal(result.slug, "new_field");
    assert.equal(result.name, "New Field");
    assert.equal(result.type, "date");
  });
});

// ---------------------------------------------------------------------------
// Test 4: upsertCustomField — update by slug
// ---------------------------------------------------------------------------

describe("upsertCustomField — update by slug", () => {
  it("keeps existing uuid; updates name; refetch returns updated row", async () => {
    let callCount = 0;
    let capturedBody = "";

    const refetchHtml = buildForm(
      fieldRow(0, "uuid-cccc-0000-0000-000000000001", "New Name", "string", "existing", "original description") +
      fieldRow(1, "uuid-dddd-0000-0000-000000000002", "Other",    "date",   "other",    "another field"),
    );

    const fetchImpl: typeof fetch = async (_input, init) => {
      callCount++;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        capturedBody = (init?.body as string) ?? "";
        return new Response("", {
          status: 302,
          headers: { Location: "/management/customer-fields" },
        });
      }
      if (callCount <= 2) {
        return fakeResponse(EXISTING_SLUG_HTML);
      }
      return fakeResponse(refetchHtml);
    };

    const c = makeClient(fetchImpl);
    const result = await upsertCustomField(c, {
      uuid: null,
      name: "New Name",
      type: "string",
      slug: "existing",
      description: "original description",
    });

    const params = new URLSearchParams(capturedBody);

    // Row 0 — uuid preserved, name changed
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][0][uuid]"), "uuid-cccc-0000-0000-000000000001");
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][0][name]"), "New Name");
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][0][slug]"), "existing");

    assert.equal(result.slug, "existing");
    assert.equal(result.name, "New Name");
    assert.equal(result.uuid, "uuid-cccc-0000-0000-000000000001");
  });
});

// ---------------------------------------------------------------------------
// Test 5: upsertCustomField — slug validation
// ---------------------------------------------------------------------------

describe("upsertCustomField — slug validation", () => {
  it("throws before any fetch when slug is invalid", async () => {
    let fetchCalled = false;
    const c = makeClient(async () => {
      fetchCalled = true;
      return fakeResponse(TWO_ROW_HTML);
    });

    await assert.rejects(
      () =>
        upsertCustomField(c, {
          uuid: null,
          name: "Bad",
          type: "string",
          slug: "Bad Slug",
          description: "",
        }),
      (err: Error) => {
        assert.ok(err.message.includes("Bad Slug"), `expected slug in message: ${err.message}`);
        return true;
      },
    );
    assert.equal(fetchCalled, false, "fetch should not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 6: upsertCustomField — type validation
// ---------------------------------------------------------------------------

describe("upsertCustomField — type validation", () => {
  it("throws before any fetch when type is not in enum", async () => {
    let fetchCalled = false;
    const c = makeClient(async () => {
      fetchCalled = true;
      return fakeResponse(TWO_ROW_HTML);
    });

    await assert.rejects(
      () =>
        upsertCustomField(c, {
          uuid: null,
          name: "Bad Type Field",
          type: "zorp" as unknown as import("../src/client/custom_fields.js").CustomFieldType,
          slug: "valid_slug",
          description: "",
        }),
      (err: Error) => {
        assert.ok(err.message.includes("zorp"), `expected 'zorp' in message: ${err.message}`);
        return true;
      },
    );
    assert.equal(fetchCalled, false, "fetch should not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 7: upsertCustomField — cap check
// ---------------------------------------------------------------------------

describe("upsertCustomField — cap check", () => {
  it("throws when current count is 225 and trying to insert", async () => {
    const c = makeClient(async () => fakeResponse(CAP_HTML));

    await assert.rejects(
      () =>
        upsertCustomField(c, {
          uuid: null,
          name: "Extra Field",
          type: "string",
          slug: "extra_field",
          description: "",
        }),
      (err: Error) => {
        assert.ok(
          err.message.includes("225"),
          `expected '225' in cap message: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Test 8: deleteCustomField by slug
// ---------------------------------------------------------------------------

describe("deleteCustomField — by slug", () => {
  it("POST body omits the middle row; refetch confirms deletion", async () => {
    let callCount = 0;
    let capturedBody = "";

    // 3-row fixture; delete slug "party_size" (row 1)
    // After delete the refetch returns only rows 0 and 2
    const afterDeleteHtml = buildForm(
      fieldRow(0, "uuid-0000-0000-0000-000000000001", "Call Intent",  "string",  "call_intent",  "The detected intent") +
      fieldRow(2, "uuid-0000-0000-0000-000000000003", "Is VIP",       "boolean", "is_vip",       ""),
    );

    const fetchImpl: typeof fetch = async (_input, init) => {
      callCount++;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        capturedBody = (init?.body as string) ?? "";
        return new Response("", {
          status: 302,
          headers: { Location: "/management/customer-fields" },
        });
      }
      // GET 1 = initial form, GET 2 = refetch
      if (callCount <= 2) {
        return fakeResponse(THREE_ROW_HTML);
      }
      return fakeResponse(afterDeleteHtml);
    };

    const c = makeClient(fetchImpl);
    await deleteCustomField(c, { slug: "party_size" });

    const params = new URLSearchParams(capturedBody);

    // Row 0 should still be present
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][0][slug]"), "call_intent");
    // Row 2 should still be present
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][2][slug]"), "is_vip");
    // Row 1 (party_size) must be absent
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][1][slug]"), null);
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][1][uuid]"), null);
  });
});

// ---------------------------------------------------------------------------
// Test 9: deleteCustomField — refetch detects failure
// ---------------------------------------------------------------------------

describe("deleteCustomField — refetch detects failure", () => {
  it("throws with 'omit-row delete convention' message when row is still present", async () => {
    let callCount = 0;

    const fetchImpl: typeof fetch = async (_input, init) => {
      callCount++;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        return new Response("", {
          status: 302,
          headers: { Location: "/management/customer-fields" },
        });
      }
      // All GETs (initial + refetch) return the same 3-row fixture
      return fakeResponse(THREE_ROW_HTML);
    };

    const c = makeClient(fetchImpl);

    await assert.rejects(
      () => deleteCustomField(c, { slug: "party_size" }),
      (err: Error) => {
        assert.ok(
          err.message.includes("omit-row delete convention"),
          `expected convention message: ${err.message}`,
        );
        assert.ok(
          err.message.includes("party_size"),
          `expected slug in message: ${err.message}`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Test 10: upsertCustomField — insert into empty form lands at index 1
// ---------------------------------------------------------------------------

const EMPTY_FORM_HTML = buildForm("");

describe("upsertCustomField — insert into empty form", () => {
  it("POSTs new row at index 1 (Yii bulk forms are 1-indexed) when form has no rows", async () => {
    let callCount = 0;
    let capturedBody = "";

    const refetchHtml = buildForm(
      fieldRow(1, "uuid-new-empty-000000000001", "Brand New", "string", "brand_new", "first field ever"),
    );

    const fetchImpl: typeof fetch = async (_input, init) => {
      callCount++;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        capturedBody = (init?.body as string) ?? "";
        return new Response("", {
          status: 302,
          headers: { Location: "/management/customer-fields" },
        });
      }
      // GET 1 = initial empty form, GET 2+ = refetch with new row
      if (callCount <= 2) {
        return fakeResponse(EMPTY_FORM_HTML);
      }
      return fakeResponse(refetchHtml);
    };

    const c = makeClient(fetchImpl);
    const result = await upsertCustomField(c, {
      uuid: null,
      name: "Brand New",
      type: "string",
      slug: "brand_new",
      description: "first field ever",
    });

    const params = new URLSearchParams(capturedBody);

    // Empty form → maxIndex initialises to 0 → newIndex = 0 + 1 = 1
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][1][uuid]"), "");
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][1][name]"), "Brand New");
    assert.equal(params.get("UpdateOrCreateCustomerFieldForm[fields][1][slug]"), "brand_new");

    assert.equal(result.slug, "brand_new");
    assert.equal(result.name, "Brand New");
  });
});
