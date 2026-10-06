import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

console.log("Building coding-tool-picker...");

console.log("1. Compiling TypeScript engine...");
execSync("npx tsc", { stdio: "inherit" });

console.log("2. Reading rules and engine...");
const rulesText = readFileSync("jev/choose_coding_plan.rules.json", "utf8");
const rules = JSON.parse(rulesText);

let engine = readFileSync("out/engine.js", "utf8");
const names = [...engine.matchAll(/^export (?:function|const) (\w+)/gm)].map((m) => m[1]);
engine = engine.replace(/^export /gm, "");
const engineIife = `window.CodingPlan = (function () {\n"use strict";\n${engine}\nreturn { ${names.join(", ")} };\n})();`;

console.log("3. Reading app JavaScript and template...");
const app = readFileSync("src/app.js", "utf8");
const tpl = readFileSync("src/template.html", "utf8");

console.log("4. Generating index.html...");
mkdirSync("dist", { recursive: true });

const html = tpl
  .replace("/*RULES_JSON*/", () => JSON.stringify(rules).replace(/</g, "\\u003c"))
  .replace("/*ENGINE_JS*/", () => engineIife.replace(/<\/script/gi, "<\\/script"))
  .replace("/*APP_JS*/", () => app);

writeFileSync("dist/index.html", html);

console.log(`Built index.html (${(html.length / 1024).toFixed(1)} KB)`);
console.log(`Engine exports: ${names.length} functions`);
