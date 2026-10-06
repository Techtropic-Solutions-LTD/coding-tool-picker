import { readFileSync } from "node:fs";
import * as E from "../out/engine.js";

const rules = JSON.parse(readFileSync("./jev/choose_coding_plan.rules.json", "utf8"));
const m = E.compile(rules);

export const PERSONAS = {
  "Solo dev, AWS infra and agency builds, $60 hard (target: stack60)": {
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
  },
  "Claude loyalist, hard infra, $100 flexible": {
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
  },
  "Student, bulk editor work, $20 hard, no API bills": {
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
  },
  "ChatGPT user, scripts and bots, company pays": {
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
  },
  "Model hopper in Cursor, product and writing, $200": {
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
  },
  "Tinkerer, own scripts and keys, $20 flexible": {
    eco: "none",
    work: ["scripts"],
    where: ["terminal"],
    stakes: "routine",
    autonomy: "bots",
    musthave: "volume",
    model: "choose",
    control: "stack",
    volume: "daily",
    budget: "20",
    ceiling: "flex",
    payg: "ok"
  }
};

const pc = (x) => Math.round(x * 100);

export function run(verbose = true) {
  const out = {};
  for (const [name, a] of Object.entries(PERSONAS)) {
    let ans = { ...a };
    for (let i = 0; i < 3; i++) {
      const c = E.pendingCheck(m, ans);
      if (!c) break;
      ans[c.id] = "yes";
    }
    const r = E.evaluate(m, ans);
    const d = E.decideOffline(m, ans);
    const b = E.band(m, r);
    out[name] = {
      top: r.top?.id,
      fit: pc(r.top?.fit ?? 0),
      second: r.second?.id,
      fit2: pc(r.second?.fit ?? 0),
      band: b.band,
      conf: d.confidence,
      code: E.encode(m, ans)
    };
    if (verbose) {
      console.log(`\n## ${name}\n  answers code: ${E.encode(m, ans)}  complete=${E.isComplete(m, ans)}`);
      console.log("  ranking:", r.live.slice(0, 5).map((x) => `${x.id} ${pc(x.fit)}%`).join(" | "));
      if (r.ruledOut.length) console.log("  ruled out:", r.ruledOut.map((x) => `${x.id} (${x.out[0].why})`).join("; "));
      console.log(`  Jev-style: decision=${d.output.decision} confidence=${d.confidence} band=${b.band} source=${d.source}`);
      console.log("  fits:", d.output.fits.map((f) => f.label).join("; "), "| gaps:", d.output.gaps.map((f) => f.label).join("; ") || "none");
      console.log("  runner-up:", d.output.runner_up?.name, d.output.runner_up?.edge?.label ?? "");
      console.log("  tensions:", JSON.stringify(d.output.tensions));
      console.log("  unlocks:", JSON.stringify(E.unlocks(m, ans).map((u) => `${u.label} -> ${u.id} ${pc(u.fit)}%`)));
      console.log("  addon:", JSON.stringify(d.output.addon));
      const back = E.decode(m, E.encode(m, ans));
      console.log("  share code round-trip:", JSON.stringify(E.evaluate(m, back).top?.id) === JSON.stringify(r.top?.id));
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) run();
