# Coding Tool Picker

**Live at [https://bot-picker.techtropic.io](https://bot-picker.techtropic.io)**  
Preview: [https://coding-tool-picker.tom-94d.workers.dev](https://coding-tool-picker.tom-94d.workers.dev)

A quiz to help you pick an AI coding tool and plan (Cursor, Claude Code, Codex, or API keys) based on your work, preferences, and budget. Powered by the **Jev decision engine** running live via TypeSafe System One.

## What is Jev?

Jev is a decision engine that scores weighted answers against sourced data. This quiz uses Jev to evaluate 15 plans and stacks across your answers:

1. **You answer nine questions** about your home base, the job, where you work, stakes, budget, and practical considerations.
2. **Jev scores 15 options** - Each answer adds weighted points. Each plan or stack scores 0 to 1 on each feature you asked for, backed by cited facts from public sources.
3. **You see the working** - Points per answer, close calls, tensions where answers pull in different directions, and what would change the pick.

The scoring mechanics are adapted from the **AI Daily Brief's "Choose Your Agent" quiz** ([aidailybrief.ai/play/choose-your-agent](https://aidailybrief.ai/play/choose-your-agent)).

## How Jev Decides

### Rules Engine

Each answer adds weighted wants:
- **Lock-in**: 7 if all in, 2.5 if open to switching
- **Main job**: 4 points (split 2+2 for two picks)
- **Where you work**: 2 points per pick
- **Must-have features**: 3 points
- **Budget fit**: 2 points

**Fit calculation**: points from all wants ÷ total weight × penalties

**Penalties**:
- 0.8 for API key setup if you want "it should just work"
- 0.9 if over your flexible budget
- Further 0.8 if over double your budget

**Hard constraints**:
- "Out" gates rule options out entirely
- Gaps under 3 points = close call
- Under 50% fit = nothing fits well

### Live Jev

When you complete the quiz:

1. Your answers are sent to `/api/decide` on the Cloudflare Worker
2. The Worker prepares the Jev state: your answers + rules engine ranking + remaining candidates
3. **TypeSafe System One** makes the final call among the candidates
4. Jev returns: decision, confidence, and whether it agrees with the rules top pick

**Fail-closed**: If the API is unavailable or times out (8s), the site falls back to the local rules engine. The quiz works fully offline.

## Architecture

### Frontend
- Single-page offline HTML quiz
- Embedded rules data (choose_coding_plan.rules.json)
- Compiled decision engine (engine.ts → engine.js)
- Progressive enhancement: works offline, enhanced with live Jev when available

### Backend (Cloudflare Worker)
- **Static assets**: Serves `dist/index.html` via Cloudflare Workers Assets
- **POST /api/decide**: Live Jev decisions via TypeSafe System One SDK
- **Rate limiting**: 10 requests/minute per IP via Cloudflare Rate Limiting
- **Validation**: Answers schema, body size (4 KB), origin check (CORS)
- **Secrets**: `TYPESAFE_API_KEY` (set with `wrangler secret put`)

### Data
- **Rules**: `jev/choose_coding_plan.rules.json` - single source of truth (questions, weights, outcomes, per-feature 0-1 scores with cited facts, thresholds)
- **Schema**: `jev/choose_coding_plan.schema.json` - TypeSafe question pack definition
- **Engine**: `jev/engine.ts` - pure functions (no I/O, no DOM)

## Project Structure

```
coding-tool-picker/
├── jev/
│   ├── choose_coding_plan.rules.json    # Single source of truth
│   ├── choose_coding_plan.schema.json   # TypeSafe schema
│   ├── engine.ts                         # Decision engine (TypeScript)
│   ├── personas.mjs                      # Persona test cases
│   └── coding-plan.test.mjs             # Unit tests
├── src/
│   ├── template.html                     # HTML shell
│   ├── app.js                           # Quiz UI + live Jev integration
│   ├── worker.js                        # Cloudflare Worker (assets + API)
│   └── worker.test.mjs                  # Worker API tests
├── dist/
│   └── index.html                       # Built site (generated)
├── out/
│   └── engine.js                        # Compiled engine (generated)
├── build.mjs                            # Build script
├── wrangler.toml                        # Worker config
├── package.json
├── tsconfig.json
└── README.md
```

## Development

### Prerequisites

- Node.js 20+
- npm or pnpm

### Setup

```bash
# Install dependencies
npm install

# Copy example env file
cp .dev.vars.example .dev.vars

# Add your TypeSafe API key to .dev.vars
# Get one at https://typesafe.ai
```

### Build

```bash
# Build the site (compiles TypeScript, embeds rules and engine into HTML)
npm run build

# Output: dist/index.html
```

### Local Development

```bash
# Build and run with Wrangler dev server
npm run dev

# Open http://localhost:8787
# Live Jev will work if TYPESAFE_API_KEY is set in .dev.vars
```

### Testing

```bash
# Run unit tests
npm test

# Run persona tests (check all personas still match expected outcomes)
npm run test:personas
```

**Important**: Persona results must stay identical. The scoring logic is stable.

## Deployment

### Required Secrets

Set these in your Cloudflare account:

```bash
# Set TypeSafe API key
wrangler secret put TYPESAFE_API_KEY
# Paste your key when prompted

# Account ID is already in wrangler.toml for this project
```

Secrets are also stored as GitHub repository secrets:
- `CLOUDFLARE_API_TOKEN` - Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID

### Cloudflare API Token Permissions

The `CLOUDFLARE_API_TOKEN` needs:

**Required**:
- **Account** → **Workers Scripts** → **Edit**
- **Account** → **Account Settings** → **Read**

**For Custom Domain** (bot-picker.techtropic.io):
- **Zone** → **DNS** → **Edit** (zone: techtropic.io)
- **Zone** → **Workers Routes** → **Edit** (zone: techtropic.io)

Use the **Edit Cloudflare Workers** template as a starting point, then add DNS and Workers Routes for the custom domain.

### Deploy

Deployment happens automatically on push to `main` via GitHub Actions.

**Manual deploy**:
```bash
npm run deploy
```

### URLs

- **Production**: [https://bot-picker.techtropic.io](https://bot-picker.techtropic.io)
- **Preview** (workers.dev): [https://coding-tool-picker.tom-94d.workers.dev](https://coding-tool-picker.tom-94d.workers.dev)

## Updating the Data

1. Edit `jev/choose_coding_plan.rules.json` (the single source of truth)
2. Run `npm test` and `npm run test:personas` to verify scoring is still correct
3. Run `npm run build` to regenerate `dist/index.html`
4. Commit and push (or open a PR)

The rules JSON contains:
- **Questions and options** with weighted wants and gates
- **Features** with 0-1 scores per family and cited facts
- **Outcomes** (plans and stacks) with parts, blurb, and routing tips
- **Thresholds and confidence bands**

## Testing

### Unit Tests

```bash
npm test
```

Tests the decision engine:
- Persona outcomes match expected results
- Share code round-trip works
- Invalid codes fail gracefully

### Persona Tests

```bash
npm run test:personas
```

Runs all personas through the engine and prints:
- Ranking (top 5)
- Decision, confidence, band
- Fits, gaps, runner-up, tensions, unlocks
- Share code

**Critical**: Persona outcomes must not change. The first persona ("Solo dev, $60 hard") must land on `stack60`.

### Worker API Tests

```bash
node src/worker.test.mjs
```

Conceptual validation of:
- Answer validation
- Missing API key fallback
- Timeout fallback
- Rate limiting
- Body size limits
- CORS/origin checks

## How Share Links Work

Share links use compact codes in the `?a=` parameter:

```
https://bot-picker.techtropic.io/?a=c1...
```

**Format**: `c1` + positional base-36 digits (z = unanswered) + optional priorities

Example: `c1020z13z10z2000zzz0z0-2u5d`

The code encodes all answers and any tension priority weights. Decoding is deterministic and happens entirely in the browser.

## Data Sources

All fit values (0 to 1) are editorial judgments tied to cited facts:
- Cursor docs, Claude docs, OpenAI docs, Anthropic docs
- Artificial Analysis benchmarks (AA Coding Agent Index, Terminal-Bench 4.0)
- Pricing pages and help docs

Items marked **Unverified** could not be confirmed from a primary source (e.g., unpublished pool sizes, weekly limits).

Data as of **Oct 5-6, 2026**.

## Credits

- **Scoring mechanics** adapted from [AI Daily Brief's "Choose Your Agent" quiz](https://aidailybrief.ai/play/choose-your-agent)
- **Decision engine**: Jev, powered by TypeSafe System One
- **Made by**: [Techtropic](https://techtropic.io)

## License

MIT
