import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { YiiTransport, YiiFormError } from "../src/client/yii.js";
import type { YiiFormState } from "../src/client/yii.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** One form with all input types we need to parse. */
const SINGLE_FORM_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="csrf-token" content="abc-csrf-123">
</head>
<body>
<form id="create-agent-form" action="/ai-agent/00000000-0000-0000-0000-000000000001/edit" method="POST">

  <!-- hidden -->
  <input type="hidden" name="_submission_token" value="tok-sub-999">

  <!-- text with explicit value -->
  <input type="text" name="AiAgentForm[name]" value="Test Agent">

  <!-- no type= → treated as text -->
  <input name="AiAgentForm[main_goal]" value="Handle calls">

  <!-- textarea with multi-line + entity -->
  <textarea name="AiAgentForm[prompts]">You are an agent.
Line two with &quot;quotes&quot; &amp; ampersands.</textarea>

  <!-- select: one selected, one not -->
  <select name="AiAgentForm[language]">
    <option value="en">English</option>
    <option value="af" selected>Afrikaans</option>
  </select>

  <!-- select: no selected → first option -->
  <select name="AiAgentForm[tone]">
    <option value="formal">Formal</option>
    <option value="casual">Casual</option>
  </select>

  <!-- checkbox checked → included -->
  <input type="checkbox" name="AiAgentForm[is_summary_prompt]" value="1" checked>

  <!-- checkbox not checked → skipped -->
  <input type="checkbox" name="AiAgentForm[is_debug_prompt]" value="1">

  <!-- repeated [] suffix -->
  <input type="hidden" name="AiAgentForm[knowledge_files][]" value="file-a">
  <input type="hidden" name="AiAgentForm[knowledge_files][]" value="file-b">

</form>
</body>
</html>
`;

/** Two forms; we filter to the second. */
const TWO_FORM_HTML = `
<html>
<head>
  <meta name="csrf-token" content="csrf-two-form">
</head>
<body>
<form id="other-form" action="/other" method="POST">
  <input type="hidden" name="OtherForm[field]" value="other-value">
</form>
<form id="create-agent-form" action="/ai-agent/create" method="POST">
  <input type="hidden" name="_submission_token" value="sub-tok-agent">
  <input type="text" name="AiAgentForm[name]" value="Second Form Agent">
</form>
</body>
</html>
`;

/** Validation failure response with help-block-error. */
const VALIDATION_ERROR_HTML = `
<html><body>
<form action="/contact/edit" method="POST">
  <div class="form-group has-error">
    <div class="help-block help-block-error">Phone is required</div>
  </div>
</form>
</body></html>
`;

// ---------------------------------------------------------------------------
// Helper: build a YiiTransport with a stub fetchImpl
// ---------------------------------------------------------------------------

function fakeResponse(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html", ...headers },
  });
}

function makeTransport(
  fetchImpl: typeof fetch,
  cookieOverride?: YiiTransport extends { new(opts: infer O): unknown } ? O["cookies"] : never,
) {
  return new YiiTransport({
    yiiHost: "https://aiployee.jobix.ai",
    cookies: cookieOverride ?? {
      PHPSESSID: "sess-abc",
      _identity: "id-abc",
      _csrf: "csrf-abc",
    },
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Test 1: Parse a one-form fixture
// ---------------------------------------------------------------------------

describe("YiiTransport.getForm — single form parse", () => {
  it("extracts all required fields with bracket notation preserved", async () => {
    const t = makeTransport(async () => fakeResponse(SINGLE_FORM_HTML));
    const form = await t.getForm("/ai-agent/00000000-0000-0000-0000-000000000001/edit");

    // Hidden input
    assert.equal(form.fields["AiAgentForm[name]"], "Test Agent");

    // No-type input treated as text
    assert.equal(form.fields["AiAgentForm[main_goal]"], "Handle calls");

    // Textarea: multi-line + entity decoding
    const prompts = form.fields["AiAgentForm[prompts]"];
    assert.ok(typeof prompts === "string", "prompts is a string");
    assert.ok(prompts.includes('"quotes"'), "decoded &quot;");
    assert.ok(prompts.includes("&"), "decoded &amp;");
    assert.ok(prompts.includes("Line two"), "multi-line preserved");

    // Select with selected option
    assert.equal(form.fields["AiAgentForm[language]"], "af");

    // Select with no selected → first option
    assert.equal(form.fields["AiAgentForm[tone]"], "formal");

    // Checkbox checked → included
    assert.equal(form.fields["AiAgentForm[is_summary_prompt]"], "1");

    // Checkbox not checked → absent from fields
    assert.equal(form.fields["AiAgentForm[is_debug_prompt]"], undefined);

    // Bracket notation preserved verbatim
    assert.ok(
      Object.keys(form.fields).some((k) => k === "AiAgentForm[name]"),
      "bracket notation preserved",
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2: formId filter
// ---------------------------------------------------------------------------

describe("YiiTransport.getForm — formId filter", () => {
  it("only parses the form whose id matches", async () => {
    const t = makeTransport(async () => fakeResponse(TWO_FORM_HTML));
    const form = await t.getForm("/ai-agent/create", { formId: "create-agent-form" });

    // Should have second-form fields
    assert.equal(form.fields["AiAgentForm[name]"], "Second Form Agent");
    assert.equal(form.action, "/ai-agent/create");

    // Should NOT have first-form field
    assert.equal(form.fields["OtherForm[field]"], undefined);
  });
});

// ---------------------------------------------------------------------------
// Test 3: csrf-token meta extraction
// ---------------------------------------------------------------------------

describe("YiiTransport.getForm — csrf-token", () => {
  it("extracts the csrf-token meta content", async () => {
    const t = makeTransport(async () => fakeResponse(SINGLE_FORM_HTML));
    const form = await t.getForm("/any");
    assert.equal(form.csrfToken, "abc-csrf-123");
  });
});

// ---------------------------------------------------------------------------
// Test 4: _submission_token
// ---------------------------------------------------------------------------

describe("YiiTransport.getForm — _submission_token", () => {
  it("is extracted as submissionToken AND remains in fields", async () => {
    const t = makeTransport(async () => fakeResponse(SINGLE_FORM_HTML));
    const form = await t.getForm("/any");

    // Dedicated field
    assert.equal(form.submissionToken, "tok-sub-999");
    // Also present in fields so submitForm can re-include it
    assert.equal(form.fields["_submission_token"], "tok-sub-999");
  });

  it("is retained when overriding other fields", async () => {
    let capturedBody = "";
    const t = makeTransport(async (_url, init) => {
      capturedBody = (init as RequestInit).body as string ?? "";
      return fakeResponse("", 302, { Location: "/success" });
    });

    const form: YiiFormState = {
      fields: {
        "_submission_token": "tok-sub-999",
        "AiAgentForm[name]": "Old Name",
      },
      csrfToken: "csrf-x",
      submissionToken: "tok-sub-999",
      action: "/submit",
      method: "POST",
    };

    await t.submitForm(form, { "AiAgentForm[name]": "New Name" });

    const params = new URLSearchParams(capturedBody);
    assert.equal(params.get("_submission_token"), "tok-sub-999", "_submission_token in body");
    assert.equal(params.get("AiAgentForm[name]"), "New Name", "override applied");
  });
});

// ---------------------------------------------------------------------------
// Test 5: [] suffix repeated names become string[]
// ---------------------------------------------------------------------------

describe("YiiTransport.getForm — [] repeated names", () => {
  it("accumulates [] inputs into a string[] in order", async () => {
    const t = makeTransport(async () => fakeResponse(SINGLE_FORM_HTML));
    const form = await t.getForm("/any");

    const files = form.fields["AiAgentForm[knowledge_files][]"];
    assert.ok(Array.isArray(files), "should be array");
    assert.deepEqual(files, ["file-a", "file-b"]);
  });
});

// ---------------------------------------------------------------------------
// Test 6: submitForm request shape
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function capturingFetch(
  body: string,
  status: number,
  extraHeaders?: Record<string, string>,
): { fetchImpl: typeof fetch; captured: () => CapturedRequest } {
  let last: CapturedRequest | undefined;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    last = { url: String(input), init };
    return fakeResponse(body, status, extraHeaders);
  };
  return {
    fetchImpl,
    captured: () => {
      if (!last) throw new Error("no request captured");
      return last;
    },
  };
}

describe("YiiTransport.submitForm — request shape", () => {
  const baseForm: YiiFormState = {
    fields: {
      "_submission_token": "sub-tok-x",
      "AiAgentForm[prompts]": "Hello world",
      "AiAgentForm[knowledge_files][]": ["file-a", "file-b"],
    },
    csrfToken: "csrf-header-val",
    submissionToken: "sub-tok-x",
    action: "/ai-agent/00000000-0000-0000-0000-000000000001/edit",
    method: "POST",
  };

  it("POST to yiiHost+action, correct headers and bracket-encoded body", async () => {
    const { fetchImpl, captured } = capturingFetch("", 302, { Location: "/agents" });

    const t = new YiiTransport({
      yiiHost: "https://aiployee.jobix.ai",
      cookies: { PHPSESSID: "sess-xyz" }, // only PHPSESSID set
      fetchImpl,
    });

    await t.submitForm(baseForm, { "AiAgentForm[prompts]": "Updated prompt" });

    const req = captured();

    // Method + URL
    assert.equal(req.init.method?.toUpperCase(), "POST");
    assert.equal(req.url, "https://aiployee.jobix.ai/ai-agent/00000000-0000-0000-0000-000000000001/edit");

    const headers = req.init.headers as Record<string, string>;

    // X-CSRF-Token header
    assert.equal(headers["X-CSRF-Token"], "csrf-header-val");

    // Content-Type
    assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");

    // Accept
    assert.equal(headers["Accept"], "text/html");

    // Referer
    assert.equal(headers["Referer"], "https://aiployee.jobix.ai");

    // Cookie: only PHPSESSID present, no _identity=
    const cookie = headers["Cookie"] ?? "";
    assert.ok(cookie.includes("PHPSESSID=sess-xyz"), "PHPSESSID in Cookie");
    assert.ok(!cookie.includes("_identity="), "_identity absent from Cookie");

    // redirect: manual
    assert.equal(req.init.redirect, "manual");

    // Body: bracket-encoded keys
    const bodyStr = req.init.body as string;
    assert.ok(
      bodyStr.includes("AiAgentForm%5Bprompts%5D="),
      "bracket-encoded key AiAgentForm%5Bprompts%5D",
    );
    assert.ok(
      bodyStr.includes(encodeURIComponent("Updated prompt")),
      "override value in body",
    );

    // _submission_token in body
    assert.ok(bodyStr.includes("_submission_token=sub-tok-x"), "_submission_token in body");

    // Repeated [] values: two entries for knowledge_files[]
    const filesKey = encodeURIComponent("AiAgentForm[knowledge_files][]");
    const matches = bodyStr.split("&").filter((p) => p.startsWith(filesKey));
    assert.equal(matches.length, 2, "two entries for [] array");
    assert.ok(matches[0]?.endsWith("=file-a"), "first file value");
    assert.ok(matches[1]?.endsWith("=file-b"), "second file value");
  });
});

// ---------------------------------------------------------------------------
// Test 7: 302 to clean Location → success result
// ---------------------------------------------------------------------------

describe("YiiTransport.submitForm — 302 success", () => {
  it("returns {status: 302, finalUrl, html: ''} for clean redirect", async () => {
    const { fetchImpl } = capturingFetch("", 302, { Location: "/agents" });

    const t = makeTransport(fetchImpl);
    const form: YiiFormState = {
      fields: { "_submission_token": "tok" },
      csrfToken: "csrf",
      submissionToken: "tok",
      action: "/ai-agent/create",
      method: "POST",
    };

    const result = await t.submitForm(form, {});
    assert.equal(result.status, 302);
    assert.equal(result.finalUrl, "/agents");
    assert.equal(result.html, "");
  });
});

// ---------------------------------------------------------------------------
// Test 8: 200 with help-block-error → throws YiiFormError
// ---------------------------------------------------------------------------

describe("YiiTransport.submitForm — 200 validation failure", () => {
  it("throws YiiFormError with extracted error message", async () => {
    const { fetchImpl } = capturingFetch(VALIDATION_ERROR_HTML, 200);

    const t = makeTransport(fetchImpl);
    const form: YiiFormState = {
      fields: { "_submission_token": "tok" },
      csrfToken: "csrf",
      submissionToken: "tok",
      action: "/contact/edit",
      method: "POST",
    };

    await assert.rejects(
      () => t.submitForm(form, {}),
      (err: unknown) => {
        assert.ok(err instanceof YiiFormError, "should be YiiFormError");
        assert.equal(err.status, 200);
        assert.equal(err.errors.length, 1, "exactly one error");
        assert.ok(
          err.errors[0]?.message.includes("Phone is required"),
          `expected 'Phone is required', got: ${err.errors[0]?.message}`,
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Test 9: Missing cookies → getForm throws before any fetch
// ---------------------------------------------------------------------------

describe("YiiTransport.getForm — missing cookies", () => {
  it("throws auth incomplete error before making any fetch", async () => {
    let fetchCalled = false;
    const neverFetch: typeof fetch = async () => {
      fetchCalled = true;
      return fakeResponse("", 200);
    };

    const t = new YiiTransport({
      yiiHost: "https://aiployee.jobix.ai",
      cookies: {}, // no cookies at all
      fetchImpl: neverFetch,
    });

    await assert.rejects(
      () => t.getForm("/ai-agent/create"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("auth incomplete"),
          `expected 'auth incomplete' in message, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(fetchCalled, false, "fetch must not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 10: CRLF guard in csrf-token (optional hardening — present)
// ---------------------------------------------------------------------------

describe("YiiTransport.getForm — CRLF guard in csrf-token", () => {
  it("throws when csrf-token contains CRLF", async () => {
    const maliciousHtml = `
<html>
<head>
  <meta name="csrf-token" content="tok\r\nX-Injected: yes">
</head>
<body><form action="/x" method="POST"></form></body>
</html>`;

    const t = makeTransport(async () => fakeResponse(maliciousHtml));

    await assert.rejects(
      () => t.getForm("/x"),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("CRLF"),
          `expected CRLF in error message, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });
});
