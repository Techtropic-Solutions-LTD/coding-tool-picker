import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as E from "../out/engine.js";

const rules = JSON.parse(readFileSync("./jev/choose_coding_plan.rules.json", "utf8"));
const m = E.compile(rules);

const SOLO_INFRA = {
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
  payg: "ok"
};

const PERSONAS = [
  ["Solo dev, $60 hard", SOLO_INFRA, "stack60"],
  ["Claude loyalist, $100 flexible", {
    eco: "claude",
    lock: "all",
    work: ["infra"],
    where: ["terminal"],
    stakes: "high",
    autonomy: "long",
    musthave: "none",
    model: "mine",
    control: "knobs",
    volume: "heavy",
    budget: "100",
    ceiling: "flex",
    payg: "ok"
  }, "claude_max5"],
  ["Student, $20 hard, no API bills", {
    eco: "none",
    work: ["bulk"],
    where: ["ide"],
    stakes: "routine",
    autonomy: "ask",
    musthave: "volume",
    model: "any",
    control: "easy",
    volume: "light",
    budget: "20",
    ceiling: "hard",
    payg: "avoid"
  }, "chatgpt_plus"],
  ["ChatGPT user, company pays", {
    eco: "chatgpt",
    lock: "some",
    work: ["scripts"],
    where: ["cloud", "chat"],
    stakes: "mixed",
    autonomy: "bots",
    musthave: "review",
    model: "any",
    control: "rules",
    volume: "daily",
    budget: "company",
    ceiling: "flex",
    payg: "ok"
  }, "chatgpt_pro"],
  ["Cursor all-in, $200 hard", {
    eco: "cursor",
    lock: "all",
    work: ["product", "writing"],
    where: ["ide", "cloud"],
    stakes: "mixed",
    autonomy: "routines",
    musthave: "agent",
    model: "choose",
    control: "easy",
    volume: "heavy",
    budget: "200",
    ceiling: "hard",
    payg: "ok"
  }, "cursor_ultra"]
];

test("choose_coding_plan: personas match expected outcomes", () => {
  for (const [name, answers, want] of PERSONAS) {
    let ans = { ...answers };
    for (let i = 0; i < 3; i++) {
      const c = E.pendingCheck(m, ans);
      if (!c) break;
      ans[c.id] = "yes";
    }
    const d = E.decideOffline(m, ans);
    assert.equal(d.output.decision, want, name);
    assert.ok(d.confidence > 0, `${name}: has confidence`);
    assert.ok(d.output.fits.length > 0, `${name}: has fits`);
    assert.ok(d.output.fits.every((f) => f.sources.length > 0), `${name}: every fit cites sources`);
  }
});

test("choose_coding_plan: accepts a share code and plain answers", () => {
  let ans = { ...SOLO_INFRA };
  for (let i = 0; i < 3; i++) {
    const c = E.pendingCheck(m, ans);
    if (!c) break;
    ans[c.id] = "yes";
  }
  const code = E.encode(m, ans);
  const byCode = E.decideOffline(m, { code });
  const plain = E.decideOffline(m, ans);
  assert.equal(byCode.output.decision, "stack60");
  assert.equal(plain.output.decision, "stack60");
  assert.deepEqual(byCode.output, plain.output, "code and plain answers produce identical output");
});

test("choose_coding_plan: share code round-trip", () => {
  const ans = { ...SOLO_INFRA };
  const code = E.encode(m, ans);
  const decoded = E.decode(m, code);
  assert.deepEqual(decoded, ans, "decoded matches original");
  const r1 = E.evaluate(m, ans);
  const r2 = E.evaluate(m, decoded);
  assert.equal(r1.top?.id, r2.top?.id, "same outcome after round-trip");
});

test("choose_coding_plan: bad share code returns null", () => {
  const bad = E.decode(m, "not-a-code");
  assert.equal(bad, null, "invalid code returns null");
});
