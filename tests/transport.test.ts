import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { Transport } from "../src/client/transport.js";
import { ApiError } from "../src/schema/envelope.js";

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Response-like object. Node 20+ has a built-in `Response`
 * constructor, so we use it directly.
 */
function fakeResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function fakeFetch(body: string, status = 200): typeof fetch {
  return async () => fakeResponse(body, status);
}

function makeTransport(fetchImpl: typeof fetch): Transport {
  return new Transport({
    apiBase: "https://api.example.com",
    token: "test-token",
    fetchImpl,
  });
}

// ---------------------------------------------------------------------------
// Capture: records the last request made by fetchImpl
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function capturingFetch(body: string, status = 200): { fetchImpl: typeof fetch; captured: () => CapturedRequest } {
  let last: CapturedRequest;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    last = { url: String(input), init };
    return fakeResponse(body, status);
  };
  return {
    fetchImpl,
    captured: () => last!,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Transport.request", () => {
  it("successful envelope → returns result", async () => {
    const envelope = JSON.stringify({ success: true, code: 200, result: [1, 2, 3], errors: null });
    const t = makeTransport(fakeFetch(envelope));

    const result = await t.request<number[]>({ method: "GET", path: "/things" });
    assert.deepEqual(result, [1, 2, 3]);
  });

  it("success:false → throws ApiError with code, errors, and extracted message", async () => {
    const envelope = JSON.stringify({
      success: false,
      code: 422,
      result: null,
      errors: { message: "validation failed" },
    });
    const t = makeTransport(fakeFetch(envelope));

    await assert.rejects(
      () => t.request({ method: "POST", path: "/things", body: {} }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, "must be ApiError");
        assert.equal(err.code, 422);
        assert.ok(typeof err.errors === "object" && err.errors !== null);
        assert.ok(err.message.includes("validation failed"));
        return true;
      },
    );
  });

  it("non-JSON body (HTML error page) → throws ApiError whose errors is the truncated body text", async () => {
    const html = "<html><body>Service Unavailable</body></html>";
    const t = makeTransport(fakeFetch(html, 503));

    await assert.rejects(
      () => t.request({ method: "GET", path: "/things" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, "must be ApiError");
        assert.ok(typeof err.errors === "string", "errors should be a string for non-JSON bodies");
        assert.ok((err.errors as string).includes("Service Unavailable"));
        return true;
      },
    );
  });

  it("network error (fetch throws) → propagates as a thrown error", async () => {
    const failFetch: typeof fetch = async () => {
      throw new Error("network unreachable");
    };
    const t = makeTransport(failFetch);

    await assert.rejects(
      () => t.request({ method: "GET", path: "/things" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });

  it("Bearer header is set; Content-Type set only when there is a body", async () => {
    const envelope = JSON.stringify({ success: true, code: 200, result: null, errors: null });

    // GET (no body) — Content-Type must NOT be set
    const { fetchImpl: getImpl, captured: getCaptured } = capturingFetch(envelope);
    const tGet = makeTransport(getImpl);
    await tGet.request({ method: "GET", path: "/things" });
    const getHeaders = getCaptured().init.headers as Record<string, string>;
    assert.ok(getHeaders["Authorization"]?.startsWith("Bearer "), "Authorization header must be set");
    assert.equal(getHeaders["Content-Type"], undefined, "Content-Type must not be set on GET without body");

    // POST with body — Content-Type must be set
    const { fetchImpl: postImpl, captured: postCaptured } = capturingFetch(envelope);
    const tPost = makeTransport(postImpl);
    await tPost.request({ method: "POST", path: "/things", body: { x: 1 } });
    const postHeaders = postCaptured().init.headers as Record<string, string>;
    assert.equal(postHeaders["Content-Type"], "application/json");
  });

  it("query params are appended; undefined values are skipped", async () => {
    const envelope = JSON.stringify({ success: true, code: 200, result: null, errors: null });
    const { fetchImpl, captured } = capturingFetch(envelope);
    const t = makeTransport(fetchImpl);

    await t.request({
      method: "GET",
      path: "/search",
      query: { q: "hello", page: 2, skip: undefined },
    });

    const url = captured().url;
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("q"), "hello");
    assert.equal(parsed.searchParams.get("page"), "2");
    assert.ok(!parsed.searchParams.has("skip"), "undefined param must not be appended");
  });
});
