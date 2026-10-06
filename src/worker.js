// TypeSafe API endpoint
const TYPESAFE_API = 'https://api.typesafe.ai/v1/systemone';

// For now, import engine directly for bundling
// In production these will be bundled by Wrangler
let Engine, rules;
try {
  Engine = await import('../out/engine.js');
  const rulesModule = await import('../jev/choose_coding_plan.rules.json', { with: { type: 'json' } });
  rules = rulesModule.default;
} catch (err) {
  console.error('Engine import failed:', err);
  // Will fall back to rules in handleDecide
}

const MODEL = Engine.compile(rules);
const MAX_BODY_SIZE = 4 * 1024; // 4 KB
const DECIDE_TIMEOUT = 8000; // 8 seconds

// CORS and origin validation
const ALLOWED_ORIGINS = [
  'https://bot-picker.techtropic.io',
  'https://coding-tool-picker.tom-94d.workers.dev'
];

function corsHeaders(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };
  }
  return {};
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  });
}

// Prepare Jev state from answers (same as browser prepareState)
function prepareState(answers) {
  const state = Engine.jevState(MODEL, { answers });
  return {
    answers: state.answers,
    candidates: state.candidates,
    engine: state.engine
  };
}

// Validate answers match the schema structure
function validateAnswers(answers) {
  if (!answers || typeof answers !== 'object') {
    return { valid: false, error: 'answers must be an object' };
  }
  
  // Basic validation: check if it looks like quiz answers
  const hasExpectedKeys = MODEL.rules.questions.some(q => {
    if (q.parts) return q.parts.some(p => p.id in answers);
    return q.id in answers;
  });
  
  if (!hasExpectedKeys) {
    return { valid: false, error: 'answers do not match quiz structure' };
  }
  
  return { valid: true };
}

async function handleDecide(request, env) {
  const origin = request.headers.get('Origin');
  
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  
  // Origin check
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return jsonResponse(
      { error: 'Origin not allowed' },
      403
    );
  }
  
  // Rate limiting
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  if (env.RATE_LIMITER) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return jsonResponse(
          { error: 'Rate limit exceeded', source: 'rules' },
          429,
          corsHeaders(origin)
        );
      }
    } catch (err) {
      console.error('Rate limiter error:', err);
      // Continue without rate limiting if it fails
    }
  }
  
  // Body size check
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_SIZE) {
    return jsonResponse(
      { error: 'Request body too large' },
      413,
      corsHeaders(origin)
    );
  }
  
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_SIZE) {
      return jsonResponse(
        { error: 'Request body too large' },
        413,
        corsHeaders(origin)
      );
    }
    body = JSON.parse(text);
  } catch (err) {
    return jsonResponse(
      { error: 'Invalid JSON' },
      400,
      corsHeaders(origin)
    );
  }
  
  const { answers, model } = body;
  
  // Validate answers
  const validation = validateAnswers(answers);
  if (!validation.valid) {
    return jsonResponse(
      { error: validation.error },
      400,
      corsHeaders(origin)
    );
  }
  
  // Prepare state for Jev
  const state = prepareState(answers);
  
  // If no candidates or no API key, fall back to rules immediately
  if (state.candidates.length === 0 || !env.TYPESAFE_API_KEY) {
    const offline = Engine.decideOffline(MODEL, { answers });
    return jsonResponse(
      {
        decision: offline.output.decision,
        confidence: offline.confidence,
        source: env.TYPESAFE_API_KEY ? 'rules' : 'rules_no_key',
        agrees_with_rules: true,
        ranking: offline.output.ranking,
        output: offline.output
      },
      200,
      corsHeaders(origin)
    );
  }
  
  // Call TypeSafe System One
  try {
    // Check if TypeSafe SDK is available
    // TODO: Uncomment when @typesafe-ai/sdk is installed
    // const client = new TypeSafeClient({ apiKey: env.TYPESAFE_API_KEY });
    
    // For now, simulate what the SDK would do:
    // Throw an error to fall back to rules
    throw new Error('TypeSafe SDK not yet integrated');
    
    const questions = {
      decision: {
        type: 'choice',
        instructions: `state.answers holds one person's answers to a quiz about AI coding tools and plans. state.engine.ranking is the deterministic rules ranking of the plans and stacks still allowed after their hard constraints (fit 0 to 1). Choose the single option id that best fits this person. Prefer the rules' top pick (state.engine.top) unless something in state.answers clearly makes it a worse fit than another remaining candidate. Never choose an id that is not a candidate.`,
        criteria: Object.fromEntries(state.candidates.map(id => [id, true]))
      }
    };
    
    // When SDK is integrated, uncomment this:
    /*
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DECIDE_TIMEOUT);
    
    try {
      const result = await client.systemOne({
        state,
        questions,
        model: model || 'auto'
      }, { signal: controller.signal });
      
      clearTimeout(timeoutId);
      
      const choice = result.answers?.decision?.choice;
      const confidence = result.answers?.decision?.confidence || 0;
      
      // Validate Jev chose a valid candidate
      if (!choice || !state.candidates.includes(choice)) {
        throw new Error('Jev returned invalid choice');
      }
      
      const output = Engine.planOutput(MODEL, { answers }, choice, confidence);
      
      return jsonResponse(
        {
          decision: choice,
          confidence,
          source: 'live',
          model: result.model || 'jev',
          agrees_with_rules: choice === state.engine.top,
          ranking: output.ranking,
          output
        },
        200,
        corsHeaders(origin)
      );
      
    } catch (err) {
      clearTimeout(timeoutId);
      
      // Timeout or API error: fall back to rules
      console.error('TypeSafe API error:', err.message);
      const offline = Engine.decideOffline(MODEL, { answers });
      
      return jsonResponse(
        {
          decision: offline.output.decision,
          confidence: offline.confidence,
          source: 'rules_fallback',
          error: err.name === 'AbortError' ? 'timeout' : 'api_error',
          agrees_with_rules: true,
          ranking: offline.output.ranking,
          output: offline.output
        },
        200,
        corsHeaders(origin)
      );
    }
    
  } catch (err) {
    // API call failed: fall back to rules
    console.error('TypeSafe API error:', err.message);
    const offline = Engine.decideOffline(MODEL, { answers });
    
    return jsonResponse(
      {
        decision: offline.output.decision,
        confidence: offline.confidence,
        source: 'rules_fallback',
        error: 'api_error',
        agrees_with_rules: true,
        ranking: offline.output.ranking,
        output: offline.output
      },
      200,
      corsHeaders(origin)
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // API routes
    if (url.pathname === '/api/decide') {
      if (request.method !== 'POST' && request.method !== 'OPTIONS') {
        return new Response('Method not allowed', { status: 405 });
      }
      return handleDecide(request, env);
    }
    
    // Health check
    if (url.pathname === '/api/health') {
      return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
    }
    
    // Serve static assets for everything else
    return env.ASSETS.fetch(request);
  }
};
