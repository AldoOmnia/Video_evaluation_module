#!/usr/bin/env node
/**
 * Which radio connector went in, and when the stack said so.
 *
 * The stack works out part numbers for its fitting line (`radioFitting.js`)
 * and sends the glasses only the sentence: "fitting · black pair in",
 * "fitting · 2 more in". `replay-clip.mjs` registers each read to part
 * numbers with that same module. This takes those reads through the stack's
 * own tracker and ties the result back to the lines the server sent, so every
 * "went in" a viewer is shown is one the stack announced.
 *
 * A line that names its connector is taken at its word. A tally line gets its
 * part numbers from the nearest read here that confirmed the same number of
 * connectors. A line this pass cannot put part numbers on keeps none.
 *
 * Reads the count's own decoder had already numbered are kept for display and
 * left out of the tracker: the stack registers those frames itself and
 * refuses some, and nothing in a capture row says which.
 *
 * Also runs on a trace already written, which needs no frames and no models:
 *
 *   node tools/emotiv-replay/fit-track.mjs --stack <export> <trace.json>...
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

let runs = 0;

/**
 * @param {{polls: object[], stack: string, server: object|null}} params
 *   `polls` carry `named.{by,state}` where a read was registered; `server` is
 *   the stack's own tally for the step, from `/vision/health`
 * @returns {Promise<object|null>} the trace's `naming` block, or null when the
 *   stack export has no fitting line
 */
export async function trackFitting({ polls, stack, server }) {
  const fitPath = join(stack, "backend", "lib", "emotiv", "radioFitting.js");
  if (!existsSync(fitPath)) return null;
  const fit = await import(pathToFileURL(fitPath).href);
  runs += 1;
  const key = `replay-${process.pid}-${runs}`;
  let reads = 0;
  let announced = 0;
  let prev = null;
  const inIds = new Set();
  for (const p of polls) {
    if (!p.named) continue;
    delete p.named.went;
    delete p.named.in;
    if (p.named.by !== "fitting") continue;
    const went = fit.noteRadioFace(key, p.named.state, Math.round(p.tSent * 1000));
    reads += 1;
    announced += went.length;
    // Filled on two registered reads running is the stack's bar for "in".
    for (const [id, st] of Object.entries(p.named.state)) {
      if (st === "filled" && prev?.[id] === "filled") inIds.add(id);
    }
    prev = p.named.state;
    p.named.went = went;
    p.named.in = [...inIds];
  }

  const ids = polls.find((p) => p.answer?.module?.connectorIds)?.answer.module.connectorIds || [];
  const names = Object.fromEntries(ids.map((id) => [id, fit.panelName(id)]));
  const byName = new Map(Object.entries(names).filter(([, n]) => n).map(([id, n]) => [n, id]));

  // The lines the server sent, each at the poll it first rode.
  const lines = [];
  let prevAge = Infinity;
  let prevLine = null;
  for (const p of polls) {
    const a = p.answer?.ambient;
    const fresh = a && (a.connector === "named" || a.connector === "tally")
      && (a.line !== prevLine || (a.ageMs ?? 0) < prevAge);
    if (fresh) {
      const named = a.connector === "named";
      lines.push({
        poll: p.i,
        t: p.tBack,
        line: a.line,
        named,
        n: named ? 1 : Number((a.line.match(/(\d+) more in/) || [])[1]) || null,
      });
    }
    prevAge = a?.ageMs ?? Infinity;
    prevLine = a?.line ?? null;
  }

  const went = polls.filter((p) => p.named?.went?.length)
    .map((p) => ({ poll: p.i, t: p.tBack, ids: p.named.went, used: false }));
  const nearest = (line, fits) => went.filter((w) => !w.used && fits(w))
    .sort((a, b) => Math.abs(a.poll - line.poll) - Math.abs(b.poll - line.poll))[0] || null;
  const events = lines.map((l) => {
    let partIds = null;
    let read = null;
    if (l.named) {
      const id = byName.get(l.line.replace(/^fitting · /, "").replace(/ in$/, "")) || null;
      if (id) {
        partIds = [id];
        read = nearest(l, (w) => w.ids.length === 1 && w.ids[0] === id);
      }
    } else {
      read = nearest(l, (w) => w.ids.length === l.n);
      if (read) partIds = read.ids;
    }
    if (read) read.used = true;
    return {
      ids: partIds,
      n: l.n,
      line: l.line,
      linePoll: l.poll,
      lineT: l.t,
      readPoll: read?.poll ?? null,
      readT: read?.t ?? null,
    };
  });

  const tally = server ? { namedReads: server.namedReads, in: server.in, announced: server.announced } : null;
  return {
    method: "radioFitting.js from the stack export, run over each capture row's boxes and the whole view that poll read",
    replay: { namedReads: reads, in: inIds.size, announced },
    server: tally,
    agrees: Boolean(tally && tally.namedReads === reads && tally.in === inIds.size && tally.announced === announced),
    names,
    events,
    // Confirmed here on a read the server's line never covered. Not shown as
    // announced anywhere.
    unannounced: went.filter((w) => !w.used).map((w) => ({ ids: w.ids, readPoll: w.poll, readT: w.t })),
    linesMatched: events.every((e) => e.ids),
  };
}

// ── on a trace already written ─────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--stack");
  const expand = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);
  const stack = resolve(expand(at >= 0 ? args[at + 1] : "~/.cache/emotiv-portal-replay/Emotiv-Dakkota-worktree"));
  const files = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  if (!files.length) {
    console.error("usage: fit-track.mjs [--stack <dir>] <trace.json>...");
    process.exit(2);
  }
  for (const file of files) {
    const trace = JSON.parse(readFileSync(file, "utf8"));
    if (!trace.polls.some((p) => p.answer?.module?.zoneId === "EZ4")) {
      console.log(`${file}: not the radio step, left alone`);
      continue;
    }
    const server = (trace.radioFit?.steps || []).slice(-1)[0] || null;
    const naming = await trackFitting({ polls: trace.polls, stack, server });
    if (!naming) {
      console.log(`${file}: the stack export has no fitting line`);
      continue;
    }
    trace.naming = naming;
    writeFileSync(file, `${JSON.stringify(trace, null, 1)}\n`);
    console.log(`${file}: ${naming.events.map((e) => `${(e.ids || ["?"]).map((i) => i.slice(-2)).join("+")}@${e.lineT.toFixed(1)}`).join("  ")}`
      + ` · reads ${naming.replay.namedReads} here, ${naming.server?.namedReads ?? "?"} on the stack`);
  }
}
