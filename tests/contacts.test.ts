/**
 * contacts.test.ts — unit tests for getContact / updateContactAttribute.
 *
 * Uses inline HTML fixtures and a stubbed YiiTransport (via fetchImpl injection).
 * No live network calls.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { YiiTransport } from "../src/client/yii.js";
import { getContact, updateContactAttribute } from "../src/client/contacts.js";
import type { Client } from "../src/client/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * SaveCustomerForm with three Custom Field attributes of different input types:
 *   - detected_intent (text / string)
 *   - call_count (number / integer)
 *   - do_not_contact (select-one / boolean, "0" selected)
 */
const CONTACT_FORM_FULL_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="csrf-token" content="csrf-contact-test">
</head>
<body>
<form id="save-customer-form" action="/customers/cccccccc-0000-0000-0000-000000000001/edit" method="POST">
  <input type="hidden" name="_submission_token" value="sub-tok-contact-1">
  <input type="text" name="SaveCustomerForm[phone]" value="+27871234567">
  <input type="text" name="SaveCustomerForm[email]" value="alice@example.com">
  <input type="text" name="SaveCustomerForm[name]" value="Alice Test">
  <input type="text" name="SaveCustomerForm[timezone]" value="Africa/Johannesburg">
  <!-- Custom Field attribute: string text -->
  <input type="text" name="SaveCustomerForm[values][detected_intent]" value="booking">
  <!-- Custom Field attribute: number (integer) -->
  <input type="number" name="SaveCustomerForm[values][call_count]" value="3">
  <!-- Custom Field attribute: select-one (boolean — "0" selected) -->
  <select name="SaveCustomerForm[values][do_not_contact]">
    <option value="1">Yes</option>
    <option value="0" selected>No</option>
  </select>
</form>
</body>
</html>
`;

/**
 * SaveCustomerForm with empty email — should map to null in the DTO.
 */
const CONTACT_FORM_EMPTY_EMAIL_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="csrf-token" content="csrf-contact-test-2">
</head>
<body>
<form id="save-customer-form" action="/customers/dddddddd-0000-0000-0000-000000000002/edit" method="POST">
  <input type="hidden" name="_submission_token" value="sub-tok-contact-2">
  <input type="text" name="SaveCustomerForm[phone]" value="+27821111111">
  <input type="text" name="SaveCustomerForm[email]" value="">
  <input type="text" name="SaveCustomerForm[name]" value="Bob Test">
  <input type="text" name="SaveCustomerForm[timezone]" value="">
</form>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeResponse(
  body: string,
  status = 200,
  headers?: Record<string, string>,
): Response {
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
    getContact(uuid: string) {
      return getContact(c as unknown as Client, uuid);
    },
    updateContactAttribute(args: Parameters<typeof updateContactAttribute>[1]) {
      return updateContactAttribute(c as unknown as Client, args);
    },
  };
  return c as unknown as Client;
}

// ---------------------------------------------------------------------------
// Test 1: getContact parses full SaveCustomerForm fixture
// ---------------------------------------------------------------------------

describe("getContact — parsing full fixture", () => {
  it("returns correct DTO with top-level fields and attributes map", async () => {
    const c = makeClient(async () => fakeResponse(CONTACT_FORM_FULL_HTML));
    const contact = await getContact(c, "cccccccc-0000-0000-0000-000000000001");

    assert.equal(contact.uuid, "cccccccc-0000-0000-0000-000000000001");
    assert.equal(contact.phone, "+27871234567");
    assert.equal(contact.email, "alice@example.com");
    assert.equal(contact.name, "Alice Test");
    assert.equal(contact.timezone, "Africa/Johannesburg");

    // attributes keyed by slug
    assert.equal(contact.attributes["detected_intent"], "booking");
    assert.equal(contact.attributes["call_count"], "3");
    assert.equal(contact.attributes["do_not_contact"], "0");

    // exactly three attribute keys
    assert.deepStrictEqual(
      Object.keys(contact.attributes).sort(),
      ["call_count", "detected_intent", "do_not_contact"],
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2: getContact maps empty top-level fields to null
// ---------------------------------------------------------------------------

describe("getContact — empty top-level fields become null", () => {
  it("email and timezone are null when form value is empty string", async () => {
    const c = makeClient(async () => fakeResponse(CONTACT_FORM_EMPTY_EMAIL_HTML));
    const contact = await getContact(c, "dddddddd-0000-0000-0000-000000000002");

    assert.equal(contact.email, null);
    assert.equal(contact.timezone, null);
    assert.equal(contact.phone, "+27821111111");
    assert.equal(contact.name, "Bob Test");
  });
});

// ---------------------------------------------------------------------------
// Test 3: updateContactAttribute happy path — correct POST body
// ---------------------------------------------------------------------------

describe("updateContactAttribute — happy path POST body", () => {
  it("serialises the target attribute field and preserves other Customer fields", async () => {
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};

    const fetchImpl: typeof fetch = async (input, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST") {
        capturedBody = (init?.body as string) ?? "";
        const h = init?.headers as Record<string, string> | undefined;
        if (h) capturedHeaders = h;
        return new Response("", {
          status: 302,
          headers: {
            Location:
              "/customers/cccccccc-0000-0000-0000-000000000001",
          },
        });
      }
      void input;
      return fakeResponse(CONTACT_FORM_FULL_HTML);
    };

    const c = makeClient(fetchImpl);
    await updateContactAttribute(c, {
      contactUuid: "cccccccc-0000-0000-0000-000000000001",
      slug: "detected_intent",
      value: "modification",
    });

    // Assert the bracket-encoded key is present
    assert.ok(
      capturedBody.includes(
        "SaveCustomerForm%5Bvalues%5D%5Bdetected_intent%5D=modification",
      ),
      `expected encoded attribute key in body; got: ${capturedBody}`,
    );

    // Assert other Customer fields are preserved verbatim from the fixture
    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get("SaveCustomerForm[phone]"), "+27871234567");
    assert.equal(params.get("SaveCustomerForm[email]"), "alice@example.com");
    assert.equal(params.get("SaveCustomerForm[name]"), "Alice Test");

    // CSRF header
    assert.equal(capturedHeaders["X-CSRF-Token"], "csrf-contact-test");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Slug validation throws before any fetch
// ---------------------------------------------------------------------------

describe("updateContactAttribute — slug validation", () => {
  it("throws before any fetch when slug contains uppercase / spaces", async () => {
    let getCalled = false;
    let postCalled = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        postCalled = true;
        return fakeResponse("", 302, { Location: "/ok" });
      }
      getCalled = true;
      return fakeResponse(CONTACT_FORM_FULL_HTML);
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        updateContactAttribute(c, {
          contactUuid: "cccccccc-0000-0000-0000-000000000001",
          slug: "Bad Slug",
          value: "anything",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("Bad Slug"),
          `expected slug in error, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(getCalled, false, "GET should not have been called");
    assert.equal(postCalled, false, "POST should not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 5: CR/LF in value throws before any fetch
// ---------------------------------------------------------------------------

describe("updateContactAttribute — CR/LF in value", () => {
  it("throws before any fetch when value contains newline", async () => {
    let getCalled = false;
    let postCalled = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        postCalled = true;
        return fakeResponse("", 302, { Location: "/ok" });
      }
      getCalled = true;
      return fakeResponse(CONTACT_FORM_FULL_HTML);
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        updateContactAttribute(c, {
          contactUuid: "cccccccc-0000-0000-0000-000000000001",
          slug: "detected_intent",
          value: "abc\nxyz",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("cr") ||
            err.message.toLowerCase().includes("lf") ||
            err.message.toLowerCase().includes("newline"),
          `expected CR/LF error, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(getCalled, false, "GET should not have been called");
    assert.equal(postCalled, false, "POST should not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 6: CR/LF in contactUuid throws before any fetch
// ---------------------------------------------------------------------------

describe("updateContactAttribute — CR/LF in contactUuid", () => {
  it("throws before any fetch when contactUuid contains CR or LF", async () => {
    let getCalled = false;
    let postCalled = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        postCalled = true;
        return fakeResponse("", 302, { Location: "/ok" });
      }
      getCalled = true;
      return fakeResponse(CONTACT_FORM_FULL_HTML);
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        updateContactAttribute(c, {
          contactUuid: "uuid\r\nevil",
          slug: "detected_intent",
          value: "anything",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("cr") ||
            err.message.toLowerCase().includes("lf") ||
            err.message.toLowerCase().includes("newline"),
          `expected CR/LF error, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(getCalled, false, "GET should not have been called");
    assert.equal(postCalled, false, "POST should not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 7: Empty contactUuid throws before any fetch
// ---------------------------------------------------------------------------

describe("updateContactAttribute — empty contactUuid", () => {
  it("throws before any fetch when contactUuid is empty string", async () => {
    let getCalled = false;
    let postCalled = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        postCalled = true;
        return fakeResponse("", 302, { Location: "/ok" });
      }
      getCalled = true;
      return fakeResponse(CONTACT_FORM_FULL_HTML);
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        updateContactAttribute(c, {
          contactUuid: "",
          slug: "detected_intent",
          value: "booking",
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.toLowerCase().includes("contactuuid") ||
            err.message.toLowerCase().includes("non-empty"),
          `expected contactUuid error, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(getCalled, false, "GET should not have been called");
    assert.equal(postCalled, false, "POST should not have been called");
  });
});
