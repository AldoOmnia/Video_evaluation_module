/**
 * Intent-routing regression test — no browser, no server needed.
 *
 *   node tools/test-routing.mjs
 *
 * Every question a plant director types has to reach the right place: the MES
 * (live reading), the warnings report, or the knowledge corpus. Getting this
 * wrong is not a crash, it is a confidently wrong answer from the wrong data
 * source, so the vocabulary is pinned here.
 *
 * Two things are asserted:
 *   1. Each question routes where it should, in English AND Italian. The ITA
 *      chips and anything typed in Italian must land where their English
 *      equivalents do.
 *   2. The home chat and the Comer AI dock never disagree. Both now share
 *      isLineQuestion() from assets/platform.js; they used to hold separate
 *      copies and had drifted.
 *
 * Add a case here whenever the routing vocabulary changes.
 */
import { readFileSync } from 'node:fs';
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {} };
eval(readFileSync('eval-lab/public/assets/platform.js', 'utf8'));
const { routeOf, isLineQuestion } = window.Platform.line;

const cases = [
  // [query, expected route]
  ['What is happening on the line right now?', 'line'],
  ['Cosa succede in linea adesso?', 'line'],
  ['Who is working on station 100?', 'line'],
  ['Chi sta lavorando alla stazione 100?', 'line'],
  ['What serial number is on the station?', 'line'],
  ['Quale seriale c\u2019\u00e8 in stazione?', 'line'],
  ['What step are they on?', 'line'],
  ['A che fase sono?', 'line'],
  ['Is the MES connected?', 'line'],
  ['Il MES \u00e8 connesso?', 'line'],
  // the divergence this refactor fixes
  ['What is the operator doing right now?', 'line'],
  ['Cosa sta facendo l\u2019operatore adesso?', 'line'],
  // knowledge must NOT be captured by line or report
  ['most common mistakes on the line', 'brain'],
  ['errori pi\u00f9 comuni sul pinion guide', 'brain'],
  ['How should the big bearing cup be oriented?', 'brain'],
  ['Come si orienta la big cup?', 'brain'],
  ['what warning fires on the big cup?', 'brain'],
  ['operator tips on the shim pack', 'brain'],
  ['consigli degli operatori sullo shim pack', 'brain'],
  ['torque spec for the pinion nut', 'brain'],
  // report card
  ['Show me the glasses warnings report', 'report'],
  ['Mostrami il report degli avvisi', 'report'],
  ['how much have we saved in rework?', 'report'],
  ['quanti errori evitati?', 'report'],
  ['Which operators are on the line today?', 'line'],
  ['Quali operatori sono in linea oggi?', 'line'],
  ['operator tips on the shim pack', 'brain'],
  ['how do I orient the small cup?', 'brain'],
  ['come si monta il cuscinetto?', 'brain'],
];

let bad = 0;
for (const [q, want] of cases) {
  const got = routeOf(q);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${want.padEnd(6)} got=${got.padEnd(6)} ${q}`);
}
// The dock's 2-way split must agree with routeOf on every non-report case.
let dis = 0;
for (const [q, want] of cases) {
  if (want === 'report') continue;
  const dock = isLineQuestion(q) ? 'line' : 'brain';
  if (dock !== routeOf(q)) { dis++; console.log(`DISAGREE home=${routeOf(q)} dock=${dock}  ${q}`); }
}
console.log(`\n${cases.length - bad}/${cases.length} routed correctly; ${dis} home/dock disagreements`);
process.exit(bad || dis ? 1 : 0);
