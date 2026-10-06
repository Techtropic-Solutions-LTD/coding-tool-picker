import assert from "node:assert/strict";
import { test } from "node:test";
import { APITimeoutError } from "@typesafe-ai/sdk";
import { createWorker } from "./worker.js";

const ORIGIN = "https://bot-picker.techtropic.io";
const VALID_ANSWERS = {
  eco: "none",
  work: ["infra", "product"],
  where: ["terminal", "cloud"],
  stakes: "high",
  autonomy: "routines",
  musthave: "agent",
  model: "any",
  control: "rules",
  volume: "heavy",
  budget: "60",
  ceiling: "hard",
  payg: "ok",
  setup: "yes",
  dots: "yes",
};

function request(method, path, body, origin = ORIGIN) {
  const headers = new Headers({
    "Content-Type": "application/json",
    Origin: origin,
  });
  const init = { method, headers };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    headers.set("Content-Length", String(new TextEncoder().encode(init.body).byteLength));
  }
  return new Request(`${ORIGIN}${path}`, init);
}

function env(overrides = {}) {
  return {
    TYPESAFE_API_KEY: "test-key",
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ASSETS: { fetch: async () => new Response("index.html") },
    ...overrides,
  };
}

function mockWorker(systemOne, calls = {}) {
  return createWorker((config) => {
    calls.config = config;
    return {
      systemOne: async (...args) => {
        calls.args = args;
        return systemOne(...args);
      },
    };
  });
}

test("live success exercises the System One client path", async () => {
  const calls = {};
  const worker = mockWorker(async ({ state }) => {
    const choice = state.candidates[0];
    return {
      model: "jev-latest",
      answers: {
        decision: {
          type: "choice",
          choice,
          confidence: 0.85,
          probabilities: { [choice]: 0.85 },
        },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    };
  }, calls);

  const response = await worker.fetch(
    request("POST", "/api/decide", { answers: VALID_ANSWERS }),
    env(),
  );
  const data = await response.json();
  const [payload, options] = calls.args;

  assert.equal(response.status, 200);
  assert.equal(data.source, "live");
  assert.equal(data.decision, payload.state.candidates[0]);
  assert.equal(data.confidence, 0.85);
  assert.equal(data.model, "jev-latest");
  assert.deepEqual(calls.config, {
    apiKey: "test-key",
    logLevel: "off",
    retry: { maxRetries: 0 },
  });
  assert.equal(payload.model, "jev-latest");
  assert.deepEqual(Object.keys(payload.questions), ["decision"]);
  assert.equal(payload.questions.decision.type, "choice");
  assert.deepEqual(
    Object.keys(payload.questions.decision.criteria),
    payload.state.candidates,
  );
  assert.deepEqual(options, { timeout: 8_000 });
});

test("timeout falls back to the deterministic rules result", async () => {
  const worker = mockWorker(async () => {
    throw new APITimeoutError(8_000);
  });
  const response = await worker.fetch(
    request("POST", "/api/decide", { answers: VALID_ANSWERS }),
    env(),
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.source, "rules_fallback");
  assert.equal(data.error, "timeout");
  assert.equal(data.agrees_with_rules, true);
  assert.ok(data.decision);
});

test("a missing API key skips System One and uses rules", async () => {
  let called = false;
  const worker = mockWorker(async () => {
    called = true;
  });
  const response = await worker.fetch(
    request("POST", "/api/decide", { answers: VALID_ANSWERS }),
    env({ TYPESAFE_API_KEY: undefined }),
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.source, "rules_no_key");
  assert.equal(data.agrees_with_rules, true);
  assert.equal(called, false);
});

test("a choice outside the candidate set falls back to rules", async () => {
  const worker = mockWorker(async () => ({
    model: "jev-latest",
    answers: {
      decision: {
        type: "choice",
        choice: "not-a-candidate",
        confidence: 0.99,
        probabilities: {},
      },
    },
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const response = await worker.fetch(
    request("POST", "/api/decide", { answers: VALID_ANSWERS }),
    env(),
  );
  const data = await response.json();

  assert.equal(response.status, 200);
  assert.equal(data.source, "rules_fallback");
  assert.equal(data.error, "api_error");
  assert.equal(data.agrees_with_rules, true);
});

test("rate-limited requests return 429 before calling System One", async () => {
  let called = false;
  const worker = mockWorker(async () => {
    called = true;
  });
  const response = await worker.fetch(
    request("POST", "/api/decide", { answers: VALID_ANSWERS }),
    env({ RATE_LIMITER: { limit: async () => ({ success: false }) } }),
  );

  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, "Rate limit exceeded");
  assert.equal(called, false);
});

test("bad JSON and invalid answers return 400", async (t) => {
  const worker = mockWorker(async () => assert.fail("System One was called"));

  await t.test("bad JSON", async () => {
    const response = await worker.fetch(
      request("POST", "/api/decide", "{bad"),
      env(),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "Invalid JSON");
  });

  await t.test("invalid answers", async () => {
    const response = await worker.fetch(
      request("POST", "/api/decide", { answers: { eco: "invalid" } }),
      env(),
    );
    assert.equal(response.status, 400);
    assert.equal(
      (await response.json()).error,
      "Answers are incomplete or invalid",
    );
  });
});

test("an oversized body returns 413", async () => {
  const worker = mockWorker(async () => assert.fail("System One was called"));
  const response = await worker.fetch(
    request("POST", "/api/decide", {
      answers: { ...VALID_ANSWERS, extra: "x".repeat(5_000) },
    }),
    env(),
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "Request body too large");
});

test("a disallowed origin returns 403 without CORS headers", async () => {
  const worker = mockWorker(async () => assert.fail("System One was called"));
  const response = await worker.fetch(
    request(
      "POST",
      "/api/decide",
      { answers: VALID_ANSWERS },
      "https://example.invalid",
    ),
    env(),
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, "Origin not allowed");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});

test("allowed preflight, health, method, and asset routes work", async (t) => {
  const worker = mockWorker(async () => assert.fail("System One was called"));

  await t.test("preflight", async () => {
    const response = await worker.fetch(request("OPTIONS", "/api/decide"), env());
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  });

  await t.test("health", async () => {
    const response = await worker.fetch(request("GET", "/api/health"), env());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  await t.test("method", async () => {
    const response = await worker.fetch(request("GET", "/api/decide"), env());
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("Allow"), "POST, OPTIONS");
  });

  await t.test("assets", async () => {
    const response = await worker.fetch(request("GET", "/"), env());
    assert.equal(await response.text(), "index.html");
  });
});
