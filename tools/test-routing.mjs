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

  /* The database answers over history, not just the live snapshot. These all
     used to reach the knowledge corpus, which correctly said it had no
     production volumes and told the director to go ask the MES — the MES this
     platform is already connected to. Every prompt in tools/mes-demo-queries
     is pinned here so the demo set and the router cannot drift apart. */
  ['How many units did we build today compared to yesterday?', 'line'],
  ['Quante unità abbiamo prodotto oggi rispetto a ieri?', 'line'],
  ['Show me every NOT OK result today and which station it was on', 'line'],
  ['Which measurements went outside their min/max limits today?', 'line'],
  ['Show me the full phase history for serial PCMRS0700653', 'line'],
  ['Which operator badges have been active today and how many phases each?', 'line'],
  ['What phases does station 710 run?', 'line'],
  ['Which station had the most failures in the last 7 days?', 'line'],
  ['Quali stazioni hanno avuto scarti oggi?', 'line'],
  ['Is ST150 running right now?', 'line'],
  ['Which stations have been idle for more than an hour?', 'line'],
  ['Quanti pezzi ha fatto la ST150 questo turno?', 'line'],
  ['What is the average cycle time at ST300 today?', 'line'],
  /* A time window plus a MES object outranks procedural phrasing. */
  ['Why did ST150 fail so much this week?', 'line'],
  /* ...but the same topics without one stay tribal. */
  ['What are the most common errors at PG-04?', 'brain'],
  ['Quali sono gli errori più comuni alla PG-04?', 'brain'],
  ['what torque spec do we use on the pinion nut?', 'brain'],
  ['why does the shim pack take so many tries?', 'brain'],
  ['how should I seat the bearing cup?', 'brain'],
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
