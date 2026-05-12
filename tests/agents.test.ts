/**
 * agents.test.ts — unit tests for getAgent / updateAgent.
 *
 * Uses inline HTML fixtures and a stubbed YiiTransport (via fetchImpl injection).
 * No live network calls.
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { YiiTransport } from "../src/client/yii.js";
import { getAgent, updateAgent } from "../src/client/agents.js";
import type { Client } from "../src/client/index.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal AiAgentForm edit page — is_summary_prompt CHECKED, is_debug_prompt NOT checked.
 * phone_numbers + knowledge_websites stored as JSON in hidden fields.
 */
const AGENT_FORM_ENABLED_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="csrf-token" content="csrf-agent-test">
</head>
<body>
<form id="create-agent-form" action="/ai-agent/aaaaaaaa-0000-0000-0000-000000000001/edit" method="POST">
  <input type="hidden" name="_submission_token" value="sub-tok-agent-1">
  <input type="hidden" name="AiAgentForm[uuid]" value="aaaaaaaa-0000-0000-0000-000000000001">
  <input type="text" name="AiAgentForm[name]" value="Tracey Test">
  <textarea name="AiAgentForm[main_goal]">Handle inbound calls</textarea>
  <textarea name="AiAgentForm[prompts]">You are a helpful agent named &quot;Tracey&quot;.</textarea>
  <textarea name="AiAgentForm[opening_greeting]">Hello! How can I help?</textarea>
  <textarea name="AiAgentForm[summary_prompt]">Summarise the call in 2 sentences.</textarea>
  <!-- is_summary_prompt: hidden 0 then checkbox 1 (checked) — last wins = "1" -->
  <input type="hidden" name="AiAgentForm[is_summary_prompt]" value="0">
  <input type="checkbox" name="AiAgentForm[is_summary_prompt]" value="1" checked>
  <textarea name="AiAgentForm[debug_prompt]">Debug info here.</textarea>
  <!-- is_debug_prompt: hidden 0, checkbox NOT checked — last wins = "0" -->
  <input type="hidden" name="AiAgentForm[is_debug_prompt]" value="0">
  <input type="checkbox" name="AiAgentForm[is_debug_prompt]" value="1">
  <input type="hidden" name="AiAgentForm[phone_numbers]" value="[&quot;+27871234567&quot;,&quot;+27829876543&quot;]">
  <textarea name="AiAgentForm[knowledge_text]">Some background knowledge.</textarea>
  <input type="hidden" name="AiAgentForm[knowledge_websites]" value="[{&quot;url&quot;:&quot;https://example.com&quot;}]">
  <!-- extra field that should end up in raw -->
  <input type="hidden" name="AiAgentForm[language]" value="en">
</form>
</body>
</html>
`;

/**
 * Same form but is_summary_prompt NOT checked, is_debug_prompt CHECKED.
 */
const AGENT_FORM_DISABLED_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta name="csrf-token" content="csrf-agent-test-2">
</head>
<body>
<form id="create-agent-form" action="/ai-agent/bbbbbbbb-0000-0000-0000-000000000002/edit" method="POST">
  <input type="hidden" name="_submission_token" value="sub-tok-agent-2">
  <input type="hidden" name="AiAgentForm[uuid]" value="bbbbbbbb-0000-0000-0000-000000000002">
  <input type="text" name="AiAgentForm[name]" value="Debug Agent">
  <textarea name="AiAgentForm[main_goal]">Handle outbound calls</textarea>
  <textarea name="AiAgentForm[prompts]">You are a debug agent.</textarea>
  <textarea name="AiAgentForm[opening_greeting]">Hi!</textarea>
  <textarea name="AiAgentForm[summary_prompt]"></textarea>
  <!-- NOT checked -->
  <input type="hidden" name="AiAgentForm[is_summary_prompt]" value="0">
  <input type="checkbox" name="AiAgentForm[is_summary_prompt]" value="1">
  <textarea name="AiAgentForm[debug_prompt]">Debug mode on.</textarea>
  <!-- CHECKED -->
  <input type="hidden" name="AiAgentForm[is_debug_prompt]" value="0">
  <input type="checkbox" name="AiAgentForm[is_debug_prompt]" value="1" checked>
  <input type="hidden" name="AiAgentForm[phone_numbers]" value="[]">
  <textarea name="AiAgentForm[knowledge_text]"></textarea>
  <input type="hidden" name="AiAgentForm[knowledge_websites]" value="[]">
</form>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function fakeResponse(body: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html", ...headers },
  });
}

/**
 * Build a minimal Client-like object that exposes a YiiTransport driven by
 * a custom fetchImpl. The full Client constructor is not called to avoid auth
 * file I/O in tests.
 */
function makeClient(fetchImpl: typeof fetch): Client {
  const yt = new YiiTransport({
    yiiHost: "https://aiployee.jobix.ai",
    cookies: { PHPSESSID: "sess-test", _identity: "id-test", _csrf: "csrf-test" },
    fetchImpl,
  });
  // Return a minimal duck-typed Client with only yiiTransport, getAgent, updateAgent.
  const c = {
    yiiTransport: yt,
    getAgent(uuid: string) {
      return getAgent(c as unknown as Client, uuid);
    },
    updateAgent(update: Parameters<typeof updateAgent>[1]) {
      return updateAgent(c as unknown as Client, update);
    },
  };
  return c as unknown as Client;
}

// ---------------------------------------------------------------------------
// Test 1: getAgent parses the "enabled" fixture correctly
// ---------------------------------------------------------------------------

describe("getAgent — parsing enabled fixture", () => {
  it("returns correct typed DTO with summaryEnabled=true, debugEnabled=false", async () => {
    const c = makeClient(async () => fakeResponse(AGENT_FORM_ENABLED_HTML));
    const agent = await getAgent(c, "aaaaaaaa-0000-0000-0000-000000000001");

    assert.equal(agent.uuid, "aaaaaaaa-0000-0000-0000-000000000001");
    assert.equal(agent.name, "Tracey Test");
    assert.equal(agent.mainGoal, "Handle inbound calls");
    // entity decoded
    assert.ok(agent.prompts.includes('"Tracey"'), 'prompts has decoded quotes');
    assert.equal(agent.openingGreeting, "Hello! How can I help?");
    assert.equal(agent.summaryPrompt, "Summarise the call in 2 sentences.");
    assert.equal(agent.summaryEnabled, true);
    assert.equal(agent.debugPrompt, "Debug info here.");
    assert.equal(agent.debugEnabled, false);

    assert.deepStrictEqual(agent.phoneNumbers, ["+27871234567", "+27829876543"]);
    assert.equal(agent.knowledgeText, "Some background knowledge.");
    assert.deepStrictEqual(agent.knowledgeWebsites, [{ url: "https://example.com" }]);

    // raw contains language but NOT any typed key
    assert.equal(agent.raw["AiAgentForm[language]"], "en");
    assert.ok(!("AiAgentForm[name]" in agent.raw), "typed key not in raw");
    assert.ok(!("AiAgentForm[is_summary_prompt]" in agent.raw), "is_summary_prompt not in raw");
  });
});

// ---------------------------------------------------------------------------
// Test 2: getAgent parses the "disabled" fixture correctly
// ---------------------------------------------------------------------------

describe("getAgent — parsing disabled fixture", () => {
  it("returns summaryEnabled=false, debugEnabled=true", async () => {
    const c = makeClient(async () => fakeResponse(AGENT_FORM_DISABLED_HTML));
    const agent = await getAgent(c, "bbbbbbbb-0000-0000-0000-000000000002");

    assert.equal(agent.summaryEnabled, false);
    assert.equal(agent.debugEnabled, true);
    assert.deepStrictEqual(agent.phoneNumbers, []);
    assert.deepStrictEqual(agent.knowledgeWebsites, []);
  });
});

// ---------------------------------------------------------------------------
// Test 3: updateAgent builds correct urlencoded body
// ---------------------------------------------------------------------------

describe("updateAgent — override encoding", () => {
  it("serialises bracket keys, JSON-stringifies phoneNumbers and knowledgeWebsites", async () => {
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        capturedBody = init?.body as string ?? "";
        const h = init?.headers as Record<string, string> | undefined;
        if (h) capturedHeaders = h;
        // Simulate success 302
        return new Response("", {
          status: 302,
          headers: { Location: "/ai-agent/aaaaaaaa-0000-0000-0000-000000000001" },
        });
      }
      // GET: return the form fixture
      void url;
      return fakeResponse(AGENT_FORM_ENABLED_HTML);
    };

    const c = makeClient(fetchImpl);
    await updateAgent(c, {
      uuid: "aaaaaaaa-0000-0000-0000-000000000001",
      name: "Updated Name",
      mainGoal: "Do more",
      summaryEnabled: false,
      debugEnabled: true,
      phoneNumbers: ["+27871111111"],
      knowledgeWebsites: [{ url: "https://docs.example.com" }],
    });

    // Decode the urlencoded body
    const params = new URLSearchParams(capturedBody);

    assert.equal(params.get("AiAgentForm[name]"), "Updated Name");
    assert.equal(params.get("AiAgentForm[main_goal]"), "Do more");
    assert.equal(params.get("AiAgentForm[is_summary_prompt]"), "0");
    assert.equal(params.get("AiAgentForm[is_debug_prompt]"), "1");
    assert.equal(params.get("AiAgentForm[phone_numbers]"), JSON.stringify(["+27871111111"]));
    assert.equal(
      params.get("AiAgentForm[knowledge_websites]"),
      JSON.stringify([{ url: "https://docs.example.com" }]),
    );
    // CSRF header present
    assert.equal(capturedHeaders["X-CSRF-Token"], "csrf-agent-test");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Local validation — phoneNumbers without + prefix
// ---------------------------------------------------------------------------

describe("updateAgent — local validation: phoneNumbers E.164", () => {
  it("E.164 validation throws before any fetch", async () => {
    let getCalled = false;
    let postCalled = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        postCalled = true;
        return fakeResponse("", 302, { Location: "/ok" });
      }
      getCalled = true;
      return fakeResponse(AGENT_FORM_ENABLED_HTML);
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        updateAgent(c, {
          uuid: "aaaaaaaa-0000-0000-0000-000000000001",
          phoneNumbers: ["0877001234"],
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("E.164"),
          `expected E.164 error, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(getCalled, false, "GET should not have been called");
    assert.equal(postCalled, false, "POST should not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 5: Local validation — prompts over max length
// ---------------------------------------------------------------------------

describe("updateAgent — local validation: max text length", () => {
  it("throws before any POST when prompts exceeds 50 000 chars", async () => {
    let postCalled = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        postCalled = true;
        return fakeResponse("", 302, { Location: "/ok" });
      }
      return fakeResponse(AGENT_FORM_ENABLED_HTML);
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        updateAgent(c, {
          uuid: "aaaaaaaa-0000-0000-0000-000000000001",
          prompts: "a".repeat(50_001),
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("prompts") && err.message.includes("50000"),
          `expected max-length error, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(postCalled, false, "POST should not have been called");
  });
});

// ---------------------------------------------------------------------------
// Test 6: update.raw cannot override typed fields
// ---------------------------------------------------------------------------

describe("updateAgent — raw cannot override typed fields", () => {
  it("throws before any fetch when raw contains a typed bracket key", async () => {
    let fetchCalled = false;
    const fetchImpl: typeof fetch = async () => {
      fetchCalled = true;
      return fakeResponse(AGENT_FORM_ENABLED_HTML);
    };
    const c = makeClient(fetchImpl);

    await assert.rejects(
      () =>
        updateAgent(c, {
          uuid: "aaaaaaaa-0000-0000-0000-000000000001",
          raw: { "AiAgentForm[name]": "evil" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("AiAgentForm[name]"),
          `expected error naming the key, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.equal(fetchCalled, false, "no fetch should have been called");
  });
});
