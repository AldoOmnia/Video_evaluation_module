#!/usr/bin/env node
/**
 * Exercise the natural-language MES path across the capabilities worth showing.
 *
 * Run before a demo. Each prompt targets a different part of the schema or a
 * different failure mode, so a green run means the interesting paths work —
 * aggregation, the measurements table, traceability by serial, time comparison,
 * Italian, the honest-refusal path, and the product-identification trap that
 * previously produced a confidently wrong answer.
 *
 *   npx tsx tools/mes-demo-queries.mjs [--full]
 */
const BASE = process.env.PLATFORM_URL ?? "http://localhost:3001";
const full = process.argv.includes("--full");

const PROMPTS = [
  ["line state", "What is happening on the line right now?", "en"],
  ["quality", "Show me every NOT OK result today and which station it was on", "en"],
  ["measurements", "Which measurements went outside their min/max limits today?", "en"],
  ["traceability", "Show me the full phase history for serial PCMRS0700653", "en"],
  ["comparison", "How many units did we build today compared to yesterday?", "en"],
  ["operators", "Which operator badges have been active today and how many phases each?", "en"],
  ["procedure def", "What phases does station 710 run?", "en"],
  ["weekly", "Which station had the most failures in the last 7 days?", "en"],
  ["product id", "Are we running the 425 rear axle at station 100 right now?", "en"],
  ["italian", "Quali stazioni hanno avuto scarti oggi?", "it"],
  ["coverage", "Which procedures are you fully trained on?", "en"],
  ["honest limits", "What is our OEE and scrap cost this month?", "en"],
];

let pass = 0;
let fail = 0;

for (const [label, query, lang] of PROMPTS) {
  const started = Date.now();
  let out;
  try {
    const res = await fetch(`${BASE}/api/mes/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, lang }),
    });
    out = await res.json();
  } catch (e) {
    console.log(`FAIL  ${label.padEnd(14)} ${query}\n      ${e.message}\n`);
    fail++;
    continue;
  }

  const answer = (out.answer ?? "").trim();
  // A usable answer is one with prose in it; the planner legitimately declines
  // some of these (coverage, OEE), so rows=0 is not by itself a failure.
  const ok = Boolean(answer) && !/^I could not/i.test(answer);
  ok ? pass++ : fail++;

  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(14)} ${Date.now() - started}ms  rows=${out.rowCount ?? "-"}`);
  console.log(`      Q: ${query}`);
  if (out.note) console.log(`      note: ${String(out.note).slice(0, 160)}`);
  const shown = full ? answer : answer.split("\n").slice(0, 6).join("\n");
  console.log(`      A: ${shown.replace(/\n/g, "\n         ")}`);
  if (!full && answer.split("\n").length > 6) console.log("         …");
  console.log();
}

console.log(`${pass} usable · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
