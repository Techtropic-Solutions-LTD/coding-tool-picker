/* choose_coding_plan: the rule engine behind the coding-tool quiz and the Jev decision.
   Pure functions over the rules file (choose_coding_plan.rules.json). No I/O, no DOM:
   the same compiled code runs inside the offline HTML quiz and in the Jev decision engine.
   Mechanics adapted from the AI Daily Brief "Choose Your Agent" engine: weighted wants, 0..1 fit per
   feature, fit = points / total weight x penalties, gates (out / limit / warn), close call under
   3 points, "nothing fits well" under 50%, tensions (x2 / x0.5), relax-one-constraint unlocks. */

export interface Ev { t: string; s: string[]; u?: string }
type Cell = [number, Ev];
export interface RuleGate {
  kind: "out" | "limit" | "warn";
  ids?: string[]; parts?: string[]; families?: string[]; where?: "over_budget" | "far_over_budget" | "no_fixed_price";
  factor?: number | string; unless?: Record<string, string[]>; why: string; ev?: Ev;
}
export interface RuleWant { f: string; w: number | string; fallback?: { f: string; w: number } }
export interface RuleOption { v: string; t: string; d?: string; wants?: RuleWant[]; gates?: RuleGate[]; feature?: string; value?: number; budget?: number }
export interface RulePart { id: string; label: string; options: RuleOption[] }
export interface RuleQuestion {
  id: string; kicker: string; q: string; sub?: string; multi?: number; split?: boolean;
  options?: RuleOption[]; parts?: RulePart[];
  follow?: { id: string; unless?: Record<string, string[]>; q: string; options: RuleOption[] };
}
export interface RuleCheck {
  id: string; outcomes: string[]; unless?: Record<string, string[]>; when?: Record<string, string[]>;
  kicker: string; q: string; sub: string; options: RuleOption[]; out_why: string;
}
export interface Rules {
  rules_id: string; rules_version: string; as_of: string;
  thresholds: Record<string, number>;
  confidence: Record<string, number>;
  sources: Record<string, { label: string; url: string }>;
  families: Record<string, { name: string; maker: string }>;
  components: Record<string, { family: string; name: string; price: number | null; f?: Record<string, Cell> }>;
  features: Record<string, { label: string; combine: "max" | "sum" | "turnkey" | "share"; v: Record<string, Cell> }>;
  cost_tiers: number[];
  outcomes: Array<{ id: string; parts: string[]; blurb: string; routing: string }>;
  questions: RuleQuestion[];
  checks: RuleCheck[];
  relax: Array<{ when: Record<string, string[]>; set: Record<string, string>; label: string }>;
  unverified_general: string[];
  api_addon: Ev;
}

export type Answers = { [k: string]: unknown; priority?: Record<string, number> };
export interface Outcome { id: string; name: string; parts: string[]; families: string[]; price: number | null; blurb: string; routing: string; kind: "single" | "combo"; v: Record<string, number>; ev: Record<string, Ev> }
export interface Model { rules: Rules; outcomes: Outcome[]; byId: Record<string, Outcome>; features: Record<string, { label: string }>; units: string[] }

export interface Want { f: string; w: number; base: number; q: string; k: string }
export interface Gate { id: string; kind: "out" | "limit" | "warn"; factor: number; why: string; ev?: Ev }
export interface Row { id: string; name: string; price: number | null; raw: number; factor: number; fit: number; parts: Array<Want & { v: number }>; out: Gate[]; limits: Gate[]; warns: Gate[] }
export interface Result { wants: Want[]; total: number; rows: Row[]; live: Row[]; ruledOut: Row[]; top: Row | null; second: Row | null; tie: boolean; weak: boolean; budget: number | null }

const evOf = (t: string, s: string[], u?: string): Ev => (u ? { t, s, u } : { t, s });
const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
const arr = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
const money = (p: number | null): string => (p == null ? "pay per token" : `$${p} a month`);

// ---- 1. Materialize: one 0..1 value + one cited fact per outcome per feature ----------
export function compile(rules: Rules): Model {
  const outcomes: Outcome[] = rules.outcomes.map((o) => {
    const comps = o.parts.map((p) => {
      const c = rules.components[p];
      if (!c) throw new Error(`unknown component ${p}`);
      return { id: p, ...c };
    });
    const price = comps.some((c) => c.price == null) ? null : comps.reduce((s, c) => s + (c.price ?? 0), 0);
    const v: Record<string, number> = {}, ev: Record<string, Ev> = {};
    const combo = comps.length > 1;
    const cellOf = (c: (typeof comps)[number], f: string): Cell => {
      const own = c.f?.[f];
      if (own) return own;
      const fam = rules.features[f]?.v[c.family];
      if (!fam) throw new Error(`feature ${f} has no value for ${c.family} (${c.id})`);
      return fam;
    };
    for (const [f, def] of Object.entries(rules.features)) {
      const cells = comps.map((c) => ({ c, cell: cellOf(c, f) }));
      if (def.combine === "sum") {
        const total = Math.min(1, cells.reduce((s, x) => s + x.cell[0], 0));
        v[f] = total;
        if (!combo) ev[f] = cells[0]!.cell[1];
        else {
          const u = cells.map((x) => x.cell[1].u).filter(Boolean)[0];
          ev[f] = evOf(`${cells.length} separate usage pools: ${cells.map((x) => `${x.c.name} (${x.cell[1].t.replace(/\.$/, "")})`).join("; ")}.`, [...new Set(cells.flatMap((x) => x.cell[1].s))], u);
        }
      } else if (def.combine === "share") {
        // Ecosystem fit: the share of the stack that lives in that ecosystem (one of three plans = 1/3).
        let best = cells[0]!;
        for (const x of cells) if (x.cell[0] > best.cell[0]) best = x;
        v[f] = cells.reduce((s, x) => s + x.cell[0], 0) / cells.length;
        ev[f] = combo ? { ...best.cell[1], t: best.cell[0] > 0 ? `${best.c.name} (${cells.filter((x) => x.cell[0] > 0).length} of ${cells.length} plans in this stack): ${best.cell[1].t}` : best.cell[1].t } : best.cell[1];
      } else if (def.combine === "turnkey") {
        const step = rules.thresholds.combo_turnkey_step ?? 0.25;
        v[f] = Math.max(0, Math.min(...cells.map((x) => x.cell[0])) - step * (cells.length - 1));
        ev[f] = combo ? evOf(`A ${cells.length}-plan stack: ${cells.length === 2 ? "two" : "three"} sign-ins and ${cells.length === 2 ? "two" : "three"} usage dashboards to watch.`, ["report_main"]) : cells[0]!.cell[1];
      } else {
        let best = cells[0]!;
        for (const x of cells) if (x.cell[0] > best.cell[0]) best = x;
        v[f] = best.cell[0];
        ev[f] = combo ? { ...best.cell[1], t: `${best.c.name}: ${best.cell[1].t}` } : best.cell[1];
      }
    }
    for (const tier of rules.cost_tiers) {
      const f = `cost_${tier}`;
      if (price == null) { v[f] = 0.5; ev[f] = evOf("No fixed price; the bill follows your usage.", ["openai_models", "anthropic_models"]); }
      else { v[f] = price <= tier ? 1 : 0; ev[f] = evOf(`${money(price)}${price <= tier ? `, within about $${tier}` : `, over about $${tier}`}.`, priceSources(comps.map((c) => c.family))); }
    }
    return { id: o.id, name: comps.map((c) => c.name).join(" + "), parts: o.parts, families: [...new Set(comps.map((c) => c.family))], price,
             blurb: o.blurb, routing: o.routing, kind: combo ? "combo" : "single", v, ev };
  });
  const features: Record<string, { label: string }> = {};
  for (const [f, d] of Object.entries(rules.features)) features[f] = { label: d.label };
  for (const tier of rules.cost_tiers) features[`cost_${tier}`] = { label: `About $${tier} a month or less` };
  const units: string[] = [];
  for (const q of rules.questions) {
    if (q.parts) for (const p of q.parts) units.push(`${q.id}:${p.id}`);
    else if (q.multi) for (const o of q.options ?? []) units.push(`${q.id}:${o.v}`);
    else units.push(q.id);
  }
  return { rules, outcomes, byId: Object.fromEntries(outcomes.map((o) => [o.id, o])), features, units };
}
function priceSources(fams: string[]): string[] {
  const m: Record<string, string> = { cursor: "cursor_pricing", claude: "claude_pricing", chatgpt: "codex_pricing", api: "openai_models" };
  return [...new Set(fams.map((f) => m[f] ?? "report_main"))];
}

// ---- 2. Answers -> wants + gates ----------------------------------------------------
const matchAll = (ans: Answers, cond?: Record<string, string[]>): boolean =>
  !!cond && Object.entries(cond).every(([k, vals]) => vals.includes(String(ans[k])));
const optOf = (opts: RuleOption[] | undefined, v: unknown): RuleOption | undefined => (opts ?? []).find((o) => o.v === v);

export function budgetOf(m: Model, ans: Answers): number | null {
  const q = m.rules.questions.find((x) => x.parts?.some((p) => p.id === "budget"));
  const o = optOf(q?.parts?.find((p) => p.id === "budget")?.options, ans.budget);
  return o?.budget ?? null;
}

function collect(m: Model, ans: Answers): { wants: Want[]; gates: Gate[] } {
  const R = m.rules, prio = ans.priority ?? {}, wants: Want[] = [], gates: Gate[] = [];
  const budget = budgetOf(m, ans);
  const resolveW = (w: number | string, q: RuleQuestion): number | null => {
    if (typeof w === "number") return w;
    if (w === "$lock") { const fo = optOf(q.follow?.options, ans[q.follow?.id ?? ""]); return fo?.value ?? null; }
    if (w.startsWith("$")) return R.thresholds[w.slice(1)] ?? null;
    return Number(w);
  };
  const add = (want: RuleWant, q: RuleQuestion, k: string, scale = 1) => {
    let f = want.f, w = resolveW(want.w, q);
    if (f === "$eco_feature") {
      const eq = R.questions.find((x) => x.id === "eco");
      const feat = optOf(eq?.options, ans.eco)?.feature;
      if (feat) f = feat; else if (want.fallback) { f = want.fallback.f; w = want.fallback.w; } else return;
    }
    if (w == null || !m.features[f]) return;
    const base = w * scale;
    wants.push({ f, w: base * (prio[k] ?? 1), base, q: q.id, k });
  };
  const gate = (g: RuleGate) => {
    if (matchAll(ans, g.unless)) return;
    const factor = typeof g.factor === "number" ? g.factor : typeof g.factor === "string" ? R.thresholds[g.factor.slice(1)] ?? 1 : 1;
    for (const o of m.outcomes) {
      const hit = (g.ids && g.ids.includes(o.id)) || (g.parts && o.parts.some((p) => g.parts!.includes(p))) ||
        (g.families && o.families.some((f) => g.families!.includes(f))) ||
        (g.where === "over_budget" && budget != null && o.price != null && o.price > budget) ||
        (g.where === "far_over_budget" && budget != null && o.price != null && o.price > 2 * budget) ||
        (g.where === "no_fixed_price" && o.price == null);
      if (!hit) continue;
      const ev = g.ev ?? (g.where ? evOf(`${o.name}: ${money(o.price)}${budget != null ? `; your budget is about $${budget}` : ""}.`, priceSources(o.families)) : undefined);
      gates.push(ev ? { id: o.id, kind: g.kind, factor, why: g.why, ev } : { id: o.id, kind: g.kind, factor, why: g.why });
    }
  };
  for (const q of R.questions) {
    if (q.parts) {
      for (const p of q.parts) { const o = optOf(p.options, ans[p.id]); if (!o) continue; (o.wants ?? []).forEach((w) => add(w, q, `${q.id}:${p.id}`)); (o.gates ?? []).forEach(gate); }
    } else if (q.multi) {
      const picks = arr(ans[q.id]).slice(0, q.multi);
      for (const v of picks) { const o = optOf(q.options, v); if (!o) continue; (o.wants ?? []).forEach((w) => add(w, q, `${q.id}:${v}`, q.split ? 1 / picks.length : 1)); (o.gates ?? []).forEach(gate); }
    } else {
      const o = optOf(q.options, ans[q.id]); if (!o) continue;
      if (q.follow && !matchAll(ans, q.follow.unless) && ans[q.follow.id] == null) continue; // follow-up unanswered: skip the lock weight
      (o.wants ?? []).forEach((w) => add(w, q, q.id)); (o.gates ?? []).forEach(gate);
    }
  }
  for (const c of R.checks) if (ans[c.id] === "no" && checkApplies(c, ans)) gate({ kind: "out", ids: c.outcomes, why: c.out_why });
  return { wants, gates };
}
export function checkApplies(c: RuleCheck, ans: Answers): boolean {
  if (c.unless && matchAll(ans, c.unless)) return false;
  if (c.when && !matchAll(ans, c.when)) return false;
  return true;
}

// ---- 3. Score -----------------------------------------------------------------------
export function evaluate(m: Model, ans: Answers): Result {
  const { wants, gates } = collect(m, ans);
  const total = wants.reduce((s, x) => s + x.w, 0);
  const rows: Row[] = m.outcomes.map((o) => {
    const g = gates.filter((x) => x.id === o.id);
    const limits = g.filter((x) => x.kind === "limit");
    const factor = limits.reduce((p, x) => p * x.factor, 1);
    const parts = wants.map((x) => ({ ...x, v: o.v[x.f] ?? 0 }));
    const raw = parts.reduce((s, x) => s + x.w * x.v, 0);
    return { id: o.id, name: o.name, price: o.price, raw, factor, fit: total ? (raw / total) * factor : factor, parts,
             out: g.filter((x) => x.kind === "out"), limits, warns: g.filter((x) => x.kind === "warn") };
  });
  // Exact ties: fewer caveats, then easier start, then cheaper, then name.
  const live = rows.filter((r) => !r.out.length).sort((x, y) => {
    if (Math.abs(y.fit - x.fit) > 1e-9) return y.fit - x.fit;
    const cx = x.limits.length + x.warns.length, cy = y.limits.length + y.warns.length;
    if (cx !== cy) return cx - cy;
    const tx = m.byId[x.id]!.v.turnkey ?? 0, ty = m.byId[y.id]!.v.turnkey ?? 0;
    if (tx !== ty) return ty - tx;
    const px = x.price ?? 1e9, py = y.price ?? 1e9;
    return px - py || x.name.localeCompare(y.name);
  });
  const top = live[0] ?? null, second = live[1] ?? null;
  return { wants, total, rows, live, ruledOut: rows.filter((r) => r.out.length), top, second,
           tie: Boolean(top && second && top.fit - second.fit < m.rules.thresholds.tie!), weak: !top || top.fit < m.rules.thresholds.weak!, budget: budgetOf(m, ans) };
}

/** Jev-style confidence band for the rules pick (code policy, not a model probability). */
export function band(m: Model, r: Result): { band: "none" | "weak" | "close" | "clear" | "decisive"; confidence: number; gap: number } {
  const C = m.rules.confidence;
  if (!r.top) return { band: "none", confidence: C.none ?? 0, gap: 0 };
  const gap = r.second ? r.top.fit - r.second.fit : 1;
  const b = r.weak ? "weak" : r.tie ? "close" : gap < (C.decisive_gap ?? 0.06) ? "clear" : "decisive";
  return { band: b, confidence: C[b] ?? 0, gap };
}

export function pendingCheck(m: Model, ans: Answers): RuleCheck | null {
  const r = evaluate(m, ans);
  if (!r.top) return null;
  return m.rules.checks.find((c) => ans[c.id] == null && c.outcomes.includes(r.top!.id) && checkApplies(c, ans)) ?? null;
}

// ---- 4. Explain -----------------------------------------------------------------------
export interface Line { f: string; label: string; ev: Ev }
const merged = (row: Row) => { const mm = new Map<string, { f: string; w: number; v: number }>(); for (const p of row.parts) { const x = mm.get(p.f) ?? { f: p.f, w: 0, v: p.v }; x.w += p.w; mm.set(p.f, x); } return [...mm.values()]; };
export function explain(m: Model, row: Row, against?: Row | null): { fits: Line[]; gaps: Line[]; edge: Line | null } {
  const o = m.byId[row.id]!, parts = merged(row);
  const line = (f: string, src: Outcome): Line => ({ f, label: m.features[f]!.label, ev: src.ev[f]! });
  const fits = parts.filter((p) => p.v >= 0.75).sort((x, y) => y.w * y.v - x.w * x.v).slice(0, 3).map((p) => line(p.f, o));
  const gaps = parts.filter((p) => p.v <= 0.25 && p.w >= 1.5).sort((x, y) => y.w - x.w).slice(0, 2).map((p) => line(p.f, o));
  let edge: Line | null = null;
  if (against) {
    const a = m.byId[against.id]!;
    const d = parts.map((p) => ({ f: p.f, gain: p.w * ((a.v[p.f] ?? 0) - p.v) })).sort((x, y) => y.gain - x.gain)[0];
    if (d && d.gain > 0) edge = line(d.f, a);
  }
  return { fits, gaps, edge };
}

export interface Unit { k: string; w: number; base: number; feats: string[]; by: Record<string, { pts: number; fit: number }> }
export function receipt(m: Model, r: Result, ids: string[]): Unit[] {
  const units: Array<Omit<Unit, "by">> = [];
  for (const w of r.wants) {
    let u = units.find((x) => x.k === w.k);
    if (!u) units.push((u = { k: w.k, w: 0, base: 0, feats: [] }));
    u.w += w.w; u.base += w.base; if (!u.feats.includes(w.f)) u.feats.push(w.f);
  }
  return units.map((u) => ({ ...u, by: Object.fromEntries(ids.map((id) => {
    const pts = r.wants.filter((w) => w.k === u.k).reduce((s, w) => s + w.w * (m.byId[id]!.v[w.f] ?? 0), 0);
    return [id, { pts, fit: u.w ? pts / u.w : 0 }];
  })) }));
}

export function unitLabel(m: Model, k: string, ans: Answers): string {
  const [qid, sub] = k.split(":");
  const q = m.rules.questions.find((x) => x.id === qid);
  if (!q) return k;
  if (q.parts) { const p = q.parts.find((x) => x.id === sub); const o = optOf(p?.options, ans[sub ?? ""]); return `${p?.label ?? sub}: ${o?.t ?? ""}`; }
  if (q.multi) return `${q.kicker}: ${optOf(q.options, sub)?.t ?? String(sub)}`;
  const o = optOf(q.options, ans[q.id]);
  if (q.follow && ans[q.follow.id] != null) { const fo = optOf(q.follow.options, ans[q.follow.id]); return `${q.kicker}: ${o?.t ?? ""}, ${String(fo?.t ?? "").toLowerCase()}`; }
  return `${q.kicker}: ${o?.t ?? String(ans[q.id])}`;
}

// Tensions: two answers that point at different picks. Weight one x2 and the other x0.5, then the reverse.
export interface Tension { ka: string; kb: string; a: string; b: string; nameA: string; nameB: string; fitA: number; fitB: number; wa: number; wb: number; labelA: string; labelB: string; strength: number; current: boolean }
export function tensions(m: Model, ans: Answers): Tension[] {
  const T = m.rules.thresholds, UP = T.up!, DOWN = T.down!;
  const a0: Answers = { ...ans }; delete a0.priority;
  const base = evaluate(m, a0);
  if (!base.top) return [];
  const units = [...new Set(base.wants.map((w) => w.k))];
  const wOf = (k: string) => base.wants.filter((w) => w.k === k).reduce((s, w) => s + w.w, 0);
  const pull = (k: string, X: string, Y: string) => base.wants.filter((w) => w.k === k).reduce((s, w) => s + w.w * ((m.byId[X]!.v[w.f] ?? 0) - (m.byId[Y]!.v[w.f] ?? 0)), 0);
  const found: Tension[] = [];
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    let ka = units[i]!, kb = units[j]!;
    let A = evaluate(m, { ...a0, priority: { [ka]: UP, [kb]: DOWN } });
    let B = evaluate(m, { ...a0, priority: { [kb]: UP, [ka]: DOWN } });
    if (!A.top || !B.top || A.top.id === B.top.id) continue;
    if (B.top.id === base.top.id) { [ka, kb] = [kb, ka]; [A, B] = [B, A]; }
    const pa = pull(ka, A.top!.id, B.top!.id), pb = pull(kb, B.top!.id, A.top!.id);
    if (Math.min(pa, pb) < T.min_pull!) continue;
    found.push({ ka, kb, a: A.top!.id, b: B.top!.id, nameA: A.top!.name, nameB: B.top!.name, fitA: A.top!.fit, fitB: B.top!.fit,
                 wa: wOf(ka), wb: wOf(kb), labelA: unitLabel(m, ka, a0), labelB: unitLabel(m, kb, a0), strength: Math.min(pa, pb), current: A.top!.id === base.top.id });
  }
  found.sort((x, y) => Number(y.current) - Number(x.current) || y.strength - x.strength);
  const seen = new Set<string>(), picked: Tension[] = [];
  for (const t of found) { const key = [t.a, t.b].sort().join("|"); if (seen.has(key)) continue; seen.add(key); picked.push(t); if (picked.length === 2) break; }
  return picked;
}
export function prioritize(m: Model, ans: Answers, t: Tension, side: "a" | "b" | "reset"): Answers {
  const T = m.rules.thresholds, p: Record<string, number> = { ...(ans.priority ?? {}) };
  if (side === "a") { p[t.ka] = T.up!; p[t.kb] = T.down!; } else if (side === "b") { p[t.kb] = T.up!; p[t.ka] = T.down!; } else { delete p[t.ka]; delete p[t.kb]; }
  const out: Answers = { ...ans, priority: p };
  if (!Object.keys(p).length) delete out.priority;
  return out;
}
export function sideOf(m: Model, ans: Answers, t: Tension): "a" | "b" | null {
  const T = m.rules.thresholds, p = ans.priority ?? {};
  return p[t.ka] === T.up && p[t.kb] === T.down ? "a" : p[t.kb] === T.up && p[t.ka] === T.down ? "b" : null;
}

// "What would change your pick": relax one hard answer at a time.
export function unlocks(m: Model, ans: Answers, r0: Result = evaluate(m, ans)): Array<{ label: string; id: string; name: string; fit: number }> {
  const found: Array<{ label: string; id: string; name: string; fit: number }> = [];
  for (const x of m.rules.relax) {
    if (!matchAll(ans, x.when)) continue;
    const r = evaluate(m, { ...ans, ...x.set });
    if (!r.top) continue;
    const base = r0.top ? r0.top.fit : 0;
    if ((!r0.top || r.top.id !== r0.top.id) && r.top.fit - base >= m.rules.thresholds.unlock_gain!) found.push({ label: x.label, id: r.top.id, name: r.top.name, fit: r.top.fit });
  }
  return found.sort((x, y) => y.fit - x.fit).slice(0, 2);
}

/** Optional add-on within budget: the best live stack that contains the pick and still fits the budget. */
export function addon(m: Model, ans: Answers, r: Result): { kind: "stack"; id: string; name: string; fit: number; extra: number } | { kind: "api"; ev: Ev } | null {
  if (!r.top) return null;
  const top = m.byId[r.top.id]!, budget = r.budget ?? (ans.budget === "company" ? Infinity : null);
  if (budget != null && top.price != null) {
    const best = r.live.filter((x) => {
      const o = m.byId[x.id]!;
      return o.id !== top.id && o.price != null && o.price > top.price! && o.price <= budget && top.parts.every((p) => o.parts.includes(p));
    })[0];
    if (best) return { kind: "stack", id: best.id, name: best.name, fit: best.fit, extra: (best.price ?? 0) - top.price };
  }
  if (ans.payg !== "avoid" && !top.parts.includes("api_payg")) return { kind: "api", ev: m.rules.api_addon };
  return null;
}

// ---- 5. Share codes: "c1" + positional base-36 digits (z = unanswered) + optional "-" priorities ----
function fields(m: Model): Array<{ k: string; opts: string[]; mask?: boolean }> {
  const f: Array<{ k: string; opts: string[]; mask?: boolean }> = [];
  for (const q of m.rules.questions) {
    if (q.parts) for (const p of q.parts) f.push({ k: p.id, opts: p.options.map((o) => o.v) });
    else { f.push({ k: q.id, opts: (q.options ?? []).map((o) => o.v), mask: !!q.multi }); if (q.follow) f.push({ k: q.follow.id, opts: q.follow.options.map((o) => o.v) }); }
  }
  for (const c of m.rules.checks) f.push({ k: c.id, opts: c.options.map((o) => o.v) });
  return f;
}
export function encode(m: Model, a: Answers): string {
  let code = "c1";
  for (const { k, opts, mask } of fields(m)) {
    if (mask) { const picks = arr(a[k]); code += opts.reduce((n, v, i) => n | (picks.includes(v) ? 1 << i : 0), 0).toString(36); continue; }
    const i = a[k] == null ? -1 : opts.indexOf(String(a[k]));
    code += i < 0 ? "z" : i.toString(36);
  }
  const T = m.rules.thresholds;
  const pr = Object.entries(a.priority ?? {}).filter(([k, v]) => m.units.includes(k) && (v === T.up || v === T.down));
  if (pr.length) code += "-" + pr.map(([k, v]) => m.units.indexOf(k).toString(36) + (v === T.up ? "u" : "d")).join("");
  return code;
}
export function decode(m: Model, code: unknown): Answers | null {
  const F = fields(m);
  const re = new RegExp(`^c1([0-9a-z]{${F.length}})(?:-((?:[0-9a-z][ud])+))?$`);
  const mm = re.exec(String(code ?? ""));
  if (!mm) return null;
  const a: Answers = {}, body = mm[1]!, T = m.rules.thresholds;
  for (let i = 0; i < F.length; i++) {
    const { k, opts, mask } = F[i]!, ch = body[i]!;
    if (mask) { const n = parseInt(ch, 36); if (n >= 1 << opts.length) return null; const picks = opts.filter((_, j) => n & (1 << j)); if (picks.length) a[k] = picks; continue; }
    if (ch === "z") continue;
    const v = opts[parseInt(ch, 36)];
    if (v == null) return null;
    a[k] = v;
  }
  if (mm[2]) { const p: Record<string, number> = {}; for (let i = 0; i < mm[2].length; i += 2) { const u = m.units[parseInt(mm[2][i]!, 36)]; if (!u) return null; p[u] = mm[2][i + 1] === "u" ? T.up! : T.down!; } a.priority = p; }
  return a;
}
export function isComplete(m: Model, a: Answers): boolean {
  for (const q of m.rules.questions) {
    if (q.parts) { if (q.parts.some((p) => a[p.id] == null)) return false; continue; }
    if (q.multi) { if (!arr(a[q.id]).length) return false; continue; }
    if (a[q.id] == null) return false;
    if (q.follow && !matchAll(a, q.follow.unless) && a[q.follow.id] == null) return false;
  }
  return true;
}

// ---- 6. The Jev decision -----------------------------------------------------------------
export const SCHEMA_ID = "choose_coding_plan";
export interface PlanLine { feature: string; label: string; why: string; sources: string[]; unverified?: string }
export interface CodingPlanOutput {
  decision: string; name: string | null; price: number | null; blurb: string | null; routing: string | null;
  ranking: Array<{ id: string; name: string; price: number | null; fit: number }>;
  ruled_out: Array<{ id: string; why: string }>;
  fits: PlanLine[]; gaps: PlanLine[];
  runner_up: { id: string; name: string; fit: number; edge: PlanLine | null } | null;
  tensions: Array<{ a: { answer: string; pick: string }; b: { answer: string; pick: string } }>;
  addon: { kind: "stack"; id: string; name: string; fit: number; extra: number } | { kind: "api"; text: string; sources: string[] } | null;
  band: string; rules_top: string | null; agrees_with_rules: boolean; rules_version: string; confidence: number;
}
const pl = (l: Line): PlanLine => (l.ev.u ? { feature: l.f, label: l.label, why: l.ev.t, sources: l.ev.s, unverified: l.ev.u } : { feature: l.f, label: l.label, why: l.ev.t, sources: l.ev.s });

export function normalizeAnswers(m: Model, input: unknown): Answers {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (str(o.code)) { const d = decode(m, o.code); if (!d) throw new Error("bad share code"); return d; }
  if (o.answers && typeof o.answers === "object") return o.answers as Answers;
  return o as Answers;
}

/** State handed to Jev: the answers plus the rules' working, so live Jev and the stub read the same thing. */
export function jevState(m: Model, input: unknown) {
  const answers = normalizeAnswers(m, input);
  const r = evaluate(m, answers), b = band(m, r);
  return {
    answers, candidates: r.live.map((x) => x.id),
    engine: { rules_version: m.rules.rules_version, top: r.top?.id ?? null, band: b.band, confidence_hint: b.confidence, gap_points: Math.round(b.gap * 1000) / 10,
              ranking: r.live.map((x) => ({ id: x.id, name: x.name, price: x.price, fit: Math.round(x.fit * 1000) / 1000 })),
              ruled_out: r.ruledOut.map((x) => ({ id: x.id, why: x.out[0]?.why ?? "" })) },
  };
}

/** Normalized output for a chosen outcome (Jev's choice, or the rules top in stub mode). */
export function planOutput(m: Model, input: unknown, choice: string | null, confidence: number): CodingPlanOutput {
  const answers = normalizeAnswers(m, input);
  const r = evaluate(m, answers), b = band(m, r);
  const row = choice ? r.live.find((x) => x.id === choice) ?? null : null;
  const other = row ? (row.id === r.top?.id ? r.second : r.top) : null;
  const ex = row ? explain(m, row, other) : null;
  const o = row ? m.byId[row.id]! : null;
  const ad = row ? addon(m, answers, { ...r, top: row }) : null;
  return {
    decision: row ? row.id : "needs_human", name: o?.name ?? null, price: o?.price ?? null, blurb: o?.blurb ?? null, routing: o?.routing ?? null,
    ranking: r.live.map((x) => ({ id: x.id, name: x.name, price: x.price, fit: Math.round(x.fit * 1000) / 1000 })),
    ruled_out: r.ruledOut.map((x) => ({ id: x.id, why: x.out[0]?.why ?? "" })),
    fits: ex ? ex.fits.map(pl) : [], gaps: ex ? ex.gaps.map(pl) : [],
    runner_up: other && ex ? { id: other.id, name: other.name, fit: Math.round(other.fit * 1000) / 1000, edge: ex.edge ? pl(ex.edge) : null } : null,
    tensions: tensions(m, answers).map((t) => ({ a: { answer: t.labelA, pick: t.a }, b: { answer: t.labelB, pick: t.b } })),
    addon: !ad ? null : ad.kind === "api" ? { kind: "api", text: ad.ev.t, sources: ad.ev.s } : ad,
    band: b.band, rules_top: r.top?.id ?? null, agrees_with_rules: !!row && row.id === r.top?.id, rules_version: m.rules.rules_version,
    confidence: row ? confidence : 0,
  };
}

/** What the decision engine returns for this quiz, using the rules-based policy (used offline by the quiz). */
export function decideOffline(m: Model, input: unknown, now: Date = new Date()) {
  const st = jevState(m, input);
  const top = st.engine.top;
  if (!top) return { schema_id: SCHEMA_ID, output: planOutput(m, input, null, 0), confidence: 0, model: "none", ts: now.toISOString(), source: "fail_closed" as const, error: "no candidates left after hard constraints" };
  const conf = st.engine.confidence_hint;
  return { schema_id: SCHEMA_ID, output: planOutput(m, input, top, conf), confidence: conf, model: "stub", ts: now.toISOString(), source: "stub" as const };
}
