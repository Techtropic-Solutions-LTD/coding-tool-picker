import { APITimeoutError, TypeSafeClient } from "@typesafe-ai/sdk";
import * as Engine from "../out/engine.js";
import rules from "../jev/choose_coding_plan.rules.json" with { type: "json" };
import questionPack from "../jev/choose_coding_plan.schema.json" with { type: "json" };

const MODEL = Engine.compile(rules);
const MAX_BODY_SIZE = 4 * 1024;
const JEV_MODEL = "jev-latest";
const JEV_TIMEOUT_MS = 8_000;
const ALLOWED_ORIGINS = new Set([
  "https://bot-picker.techtropic.io",
  "https://coding-tool-picker.tom-94d.workers.dev",
]);

function corsHeaders(origin) {
  return ALLOWED_ORIGINS.has(origin)
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        Vary: "Origin",
      }
    : {};
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { ...corsHeaders(headers.origin), ...headers.extra },
  });
}

function matches(answers, condition) {
  return Boolean(
    condition &&
      Object.entries(condition).every(([key, values]) =>
        values.includes(String(answers[key])),
      ),
  );
}

function hasOption(options, value) {
  return options.some((option) => option.v === value);
}

function validAnswers(answers) {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return false;
  }

  const allowed = new Set(["priority"]);
  for (const question of MODEL.rules.questions) {
    if (question.parts) {
      for (const part of question.parts) {
        allowed.add(part.id);
        if (!hasOption(part.options, answers[part.id])) return false;
      }
    } else if (question.multi) {
      allowed.add(question.id);
      const values = answers[question.id];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > question.multi ||
        new Set(values).size !== values.length ||
        values.some((value) => !hasOption(question.options, value))
      ) {
        return false;
      }
    } else {
      allowed.add(question.id);
      if (!hasOption(question.options, answers[question.id])) return false;
      if (question.follow) {
        allowed.add(question.follow.id);
        if (
          !matches(answers, question.follow.unless) &&
          !hasOption(question.follow.options, answers[question.follow.id])
        ) {
          return false;
        }
      }
    }
  }

  for (const check of MODEL.rules.checks) {
    allowed.add(check.id);
    if (answers[check.id] != null && !hasOption(check.options, answers[check.id])) {
      return false;
    }
  }

  const priority = answers.priority;
  if (priority != null) {
    if (typeof priority !== "object" || Array.isArray(priority)) return false;
    const validWeights = new Set([
      MODEL.rules.thresholds.up,
      MODEL.rules.thresholds.down,
    ]);
    if (
      Object.entries(priority).some(
        ([key, value]) => !MODEL.units.includes(key) || !validWeights.has(value),
      )
    ) {
      return false;
    }
  }

  return (
    Object.keys(answers).every((key) => allowed.has(key)) &&
    Engine.isComplete(MODEL, answers)
  );
}

function rulesResponse(answers, source, error) {
  const result = Engine.decideOffline(MODEL, { answers });
  return {
    decision: result.output.decision,
    confidence: result.confidence,
    source,
    model: result.model,
    agrees_with_rules: true,
    ranking: result.output.ranking,
    output: result.output,
    ...(error ? { error } : {}),
  };
}

function buildQuestions(candidates) {
  const criteria = Object.fromEntries(
    candidates.map((id) => {
      const outcome = MODEL.byId[id];
      return [id, `${outcome.name}: ${outcome.blurb}`];
    }),
  );
  return {
    decision: {
      ...questionPack.questions.decision,
      criteria,
    },
  };
}

async function handleDecide(request, env, createClient) {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "Origin not allowed" }, 403);
  }

  const rateLimit = await env.RATE_LIMITER.limit({
    key: request.headers.get("CF-Connecting-IP") || "unknown",
  });
  if (!rateLimit.success) {
    return json({ error: "Rate limit exceeded" }, 429, { origin });
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    return json({ error: "Request body too large" }, 413, { origin });
  }

  let body;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_SIZE) {
      return json({ error: "Request body too large" }, 413, { origin });
    }
    body = JSON.parse(text);
  } catch {
    return json({ error: "Invalid JSON" }, 400, { origin });
  }

  if (!validAnswers(body?.answers)) {
    return json({ error: "Answers are incomplete or invalid" }, 400, { origin });
  }

  const answers = body.answers;
  const state = Engine.jevState(MODEL, { answers });
  if (!env.TYPESAFE_API_KEY) {
    return json(rulesResponse(answers, "rules_no_key"), 200, { origin });
  }
  if (state.candidates.length === 0) {
    return json(rulesResponse(answers, "rules"), 200, { origin });
  }

  try {
    const client = createClient({
      apiKey: env.TYPESAFE_API_KEY,
      logLevel: "off",
      retry: { maxRetries: 0 },
    });
    const result = await client.systemOne(
      {
        state,
        questions: buildQuestions(state.candidates),
        model: JEV_MODEL,
      },
      { timeout: JEV_TIMEOUT_MS },
    );
    const decision = result.answers?.decision;
    if (!decision || !state.candidates.includes(decision.choice)) {
      throw new Error("TypeSafe returned a choice outside the candidate set");
    }

    const output = Engine.planOutput(
      MODEL,
      { answers },
      decision.choice,
      decision.confidence,
    );
    return json(
      {
        decision: decision.choice,
        confidence: decision.confidence,
        source: "live",
        model: result.model,
        agrees_with_rules: decision.choice === state.engine.top,
        ranking: output.ranking,
        output,
      },
      200,
      { origin },
    );
  } catch (error) {
    const timeout =
      error instanceof APITimeoutError || error?.name === "APITimeoutError";
    console.error(
      JSON.stringify({
        message: "TypeSafe System One failed; using rules fallback",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return json(
      rulesResponse(
        answers,
        "rules_fallback",
        timeout ? "timeout" : "api_error",
      ),
      200,
      { origin },
    );
  }
}

export function createWorker(
  createClient = (config) => new TypeSafeClient(config),
) {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/decide") {
        if (request.method !== "POST" && request.method !== "OPTIONS") {
          return new Response("Method not allowed", {
            status: 405,
            headers: { Allow: "POST, OPTIONS" },
          });
        }
        return handleDecide(request, env, createClient);
      }
      if (pathname === "/api/health") {
        return json({ status: "ok" });
      }
      return env.ASSETS.fetch(request);
    },
  };
}

export default createWorker();
