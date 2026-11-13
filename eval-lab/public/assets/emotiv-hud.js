/**
 * What the glasses panel shows, worked out from a replay trace.
 *
 * A port of the decisions in the Emotiv glasses app, so the station page draws
 * the same lines the wearer would get from the same answers. Read from
 * comer-rokid-demo at `emotiv-dakkota-calipers/bolts`:
 *
 *   ui/AmbientLine.kt   which source takes the one-liner, and its fit
 *   ui/AmbientLatch.kt  when the line is allowed to change
 *   ModuleTally.kt      the progression card and the module warning
 *   ui/WarningCard.kt   which warning takes the banner, and its kicker
 *   ui/StationHud.kt    the bands, the step banner, the feed trust line
 *   ConnectorIdAgent.kt the held accusation
 *
 * Only the sources a replay has are wired: connector polls and scene reads.
 * Clip tags, the scan card, the tool card and voice need the line feed or a
 * wearer, and are not in a replay.
 */
(function (root) {
  'use strict';

  const K = Object.freeze({
    AMBIENT_LINE_CHARS: 42,
    CONNECTOR_LINE_FLOOR: 0.25,
    AMBIENT_DWELL_MS: 4000,
    AMBIENT_ACTION_DWELL_MS: 1500,
    AMBIENT_SCENE_HOLD_MS: 30000,
    AMBIENT_CONNECTOR_HOLD_MS: 6000,
    CONNECTOR_ANSWER_TTL_MS: 20000,
    SCENE_ANSWER_TTL_MS: 30000,
    ACCUSATION_ABSENCE_MS: 4500,
    CLEAR_ON_CORRECT_CONF: 0.6,
    CAMERA_STALE_MS: 2000,
    TICK_MS: 500,
    HUD_BODY_LINE_CHARS: 32,
    HUD_WARN_LINE_CHARS: 32,
    // The glasses banner is two lines, and three names would fall back to a count there.
    // A third line is kept here so each connector stays named.
    HUD_WARN_LINES: 3,
    HUD_DETAIL_CHARS: 45,
    MODULE_DETAIL_LINES: 3,
    MAX_STEP_DESC_CHARS: 90,
    FILL_STALE_MS: 3000,
    HEDGE: 'identity only',
  });

  // ── EmotivTheme.kt: fitting text to the panel ───────────────────────────
  function wrapLines(text, per) {
    const out = [];
    let cur = '';
    for (const word of String(text).split(' ').filter(Boolean)) {
      const candidate = cur ? `${cur} ${word}` : word;
      if (candidate.length <= per) cur = candidate;
      else {
        if (cur) out.push(cur);
        cur = word;
      }
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  }
  const fitsLines = (text, per, lines) => {
    const w = wrapLines(text, per);
    return w.length <= lines && w.every((l) => l.length <= per);
  };
  function fitLine(parts, per, lines = 1) {
    const kept = parts.filter((p) => String(p || '').trim());
    while (kept.length > 1 && !fitsLines(kept.join(' · '), per, lines)) kept.pop();
    return kept.join(' · ');
  }
  const trimTo = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
  const firstText = (...xs) => xs.map((x) => String(x ?? '').trim()).find(Boolean) || null;

  // ── ModuleTally.kt ──────────────────────────────────────────────────────
  function hudConnector(phrase) {
    const p = String(phrase || '');
    let raw = p.trim();
    if (p.includes(',')) raw = p.slice(p.lastIndexOf(',') + 1).trim();
    else if (p.includes(' connector ')) raw = p.slice(p.indexOf(' connector ') + 11).trim();
    for (const lead of ['the ', 'with the ', 'with ']) {
      if (raw.startsWith(lead)) raw = raw.slice(lead.length);
    }
    return raw.trim();
  }
  function unseatedLine(phrases, per = K.HUD_WARN_LINE_CHARS, lines = K.HUD_WARN_LINES) {
    const names = [...new Set((phrases || []).map(hudConnector).filter(Boolean))];
    if (!names.length) return null;
    const listed = `${names.join(' · ')} — push home`;
    if (fitsLines(listed, per, lines)) return listed;
    return names.length === 1 ? '1 not seated' : `${names.length} not seated`;
  }
  function seatWarning(module) {
    const s = module.seating || {};
    if (!s.decidable) return null;
    if (s.mode === 'flag') {
      if (!s.anyProud) return null;
      const named = unseatedLine(s.proudPhrases);
      if (named) return named;
      const check = s.total === 2 ? 'check both' : `check all ${s.total}`;
      return fitLine([`Not home — ${check}`], K.HUD_WARN_LINE_CHARS, K.HUD_WARN_LINES);
    }
    if (!(s.total > 0) || !(s.proud > 0)) return null;
    const named = unseatedLine(s.proudPhrases);
    if (named) return named;
    const parts = [s.proud === 1 ? '1 looks proud' : `${s.proud} look proud`];
    if ((s.ageMs || 0) >= K.FILL_STALE_MS) parts.push('earlier frame');
    parts.push('preview');
    return fitLine(parts, K.HUD_WARN_LINE_CHARS, K.HUD_WARN_LINES);
  }
  function moduleWarning(module) {
    const fill = module.fill || {};
    const fitted = fill.fitted;
    if (!fill.decidable || fitted == null || !(fill.total > 0)) return seatWarning(module);
    if (fitted >= fill.total) {
      if (fill.unseatedAmbiguous) return 'one loose';
      return unseatedLine(fill.unseatedPhrases) || seatWarning(module);
    }
    const parts = [`${fill.total - fitted} to fit`];
    const open = (fill.openPhrases || []).find((p) => String(p || '').trim());
    if (open) parts.push(`${hudConnector(open)} out`);
    if ((fill.ageMs || 0) >= K.FILL_STALE_MS) parts.push('earlier frame');
    parts.push(`${fitted} of ${fill.total} in`);
    return fitLine(parts, K.HUD_WARN_LINE_CHARS, K.HUD_WARN_LINES);
  }
  function moduleLine(module, recognised) {
    if (!module || !(module.total > 0)) return null;
    const n = recognised.length;
    const fill = module.fill || {};
    const fitted = fill.fitted;
    const live = Boolean(fill.decidable && fitted != null && fill.total > 0);
    const held = !live && fill.held != null && fill.total > 0 ? fill.held : null;
    const label = live
      ? `${module.name} · ${fitted} of ${fill.total} in`
      : held != null
        ? `${module.name} · ${held} of ${fill.total} in`
        : `${module.name} · ${n} of ${module.total} recognised`;
    const why = String(module.seating?.reason || '').trim() || 'seating cannot be checked';
    const warning = moduleWarning(module);
    const unseenOffRow = (module.offRowIds || []).filter((id) => !recognised.includes(id));
    const bits = [];
    if (held != null) bits.push('earlier frame');
    if (unseenOffRow.length) bits.push(`${unseenOffRow.join(', ')} not seen`);
    bits.push(n >= module.total && !(fill.decidable && fitted != null)
      ? `All ${n} seen, none verified`
      : `${n} of ${module.total} seen`);
    if (warning == null && why) bits.push(why);
    return { label, detail: fitLine(bits, K.HUD_DETAIL_CHARS, K.MODULE_DETAIL_LINES), warning };
  }

  // ── WarningCard.kt ──────────────────────────────────────────────────────
  const SEVERITY_ORDER = ['warn', 'advise', 'info'];
  const bannerDetail = (detail, label = '') => [detail, label]
    .map((x) => String(x || '').replace(/\s*·\s*\d+ms\s*$/, '').trim())
    .find(Boolean) || null;
  function warningKicker(id, severity) {
    if (id.endsWith('off-step') || id.endsWith('off-step-connector')) return 'OFF STEP';
    if (id.endsWith('wrong-station') || id.endsWith('foreign-station-part')) return 'WRONG STATION';
    return severity === 'warn' ? 'WARNING' : 'CHECK';
  }
  function warningBanner(accusation, moduleWarningText) {
    const candidates = [];
    const mw = String(moduleWarningText || '').trim();
    if (mw) candidates.push({ id: 'not-home', severity: 'warn', detail: mw, source: 'module' });
    const w = accusation?.warning;
    if (w) {
      const d = bannerDetail(w.hud?.detail, w.hud?.label);
      if (d) candidates.push({ id: w.id, severity: w.severity, detail: d, source: 'connector' });
    }
    candidates.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
    const b = candidates[0];
    return b ? { ...b, kicker: warningKicker(b.id, b.severity) } : null;
  }

  // ── StationHud.kt: the step banner's second line ────────────────────────
  const FILLER = new Set(['a', 'an', 'the', 'to', 'with', 'of', 'and', 'for', 'on', 'in', 'this']);
  const contentWords = (text) => new Set(
    String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w)),
  );
  function aidFor(label, description) {
    const desc = String(description || '').trim();
    if (!desc) return null;
    const labelWords = contentWords(label);
    if (!labelWords.size) return desc;
    const sentences = desc.split(/(?<=[.;])\s+/).filter((s) => s.trim());
    let i = 0;
    while (i < sentences.length) {
      const words = [...contentWords(sentences[i])];
      if (!(words.length && words.every((w) => labelWords.has(w)))) break;
      i += 1;
    }
    return sentences.slice(i).join(' ').trim() || null;
  }

  // ── ConnectorIdAgent.kt ─────────────────────────────────────────────────
  function connectorState(poll) {
    const a = poll?.answer;
    if (!a || poll.error) return { type: 'Unavailable', label: 'NO MATCH', detail: '' };
    const hud = a.hud || {};
    if (a.ok && (a.candidates || []).length) return { type: 'Answer', answer: a, at: poll.tBack * 1000 };
    if (a.ok && String(a.ambient?.line || '').trim()) return { type: 'Answer', answer: a, at: poll.tBack * 1000 };
    if (a.ok && !String(hud.label || '').trim() && !String(hud.detail || '').trim()) return { type: 'Idle' };
    return { type: 'Unavailable', label: String(hud.label || '').trim() || 'NO MATCH', detail: hud.detail || a.reason || '' };
  }
  function actionableWarning(a) {
    const w = a.warning || (a.warnings || [])[0];
    if (!w || (w.severity !== 'warn' && w.severity !== 'advise')) return null;
    return String(w.hud?.detail || '').trim() || String(w.hud?.label || '').trim() ? w : null;
  }
  const shownConfidence = (c) => (c?.rawConfidence ?? c?.confidence ?? 0);
  function nextAccusation(held, a, nowMs) {
    const raised = actionableWarning(a);
    if (raised) {
      const same = held && held.warning.id === raised.id && held.warning.hud?.label === raised.hud?.label;
      return same
        ? { ...held, lastSeenAtMs: nowMs }
        : { warning: raised, label: a.hud?.label || '', raisedAtMs: nowMs, lastSeenAtMs: nowMs };
    }
    if (!held) return null;
    if (shownConfidence((a.candidates || [])[0]) >= K.CLEAR_ON_CORRECT_CONF) return null;
    return held;
  }

  // ── AmbientLine.kt ──────────────────────────────────────────────────────
  const answerOf = (c) => (c?.type === 'Answer' ? c.answer : null);
  function ambientAction(c) {
    const line = String(answerOf(c)?.ambient?.line || '').trim();
    return line && line.length <= K.AMBIENT_LINE_CHARS - 2 ? line : null;
  }
  function ambientSeatLine(c) {
    const seat = answerOf(c)?.seat;
    if (!seat || !seat.unseated) return null;
    return firstText(seat.hud?.detail, seat.hud?.label);
  }
  function ambientWarning(c) {
    const a = answerOf(c);
    const w = a && (a.warning || (a.warnings || [])[0]);
    return w && w.severity === 'warn' ? w : null;
  }
  function ambientNotice(c) {
    const a = answerOf(c);
    const w = a && (a.warning || (a.warnings || [])[0]);
    if (!w || w.severity === 'warn') return null;
    return firstText(w.hud?.detail, w.hud?.label, w.summary);
  }
  function connectorClaimsLine(c) {
    const a = answerOf(c);
    if (!a) return false;
    if (a.warning?.severity === 'warn') return true;
    const top = (a.candidates || [])[0];
    return top ? shownConfidence(top) >= K.CONNECTOR_LINE_FLOOR : false;
  }
  function scenePhrase(s) {
    if (s?.type === 'Answer') {
      const a = s.answer;
      return [a.summary, a.hud?.detail, a.hud?.label]
        .map((x) => String(x || '').trim())
        .find((x) => x && x !== 'HARNESS VIEW') || null;
    }
    if (s?.type === 'Unavailable') return String(s.label || '').trim() || null;
    return null;
  }
  function ambientText(c, s) {
    if (c?.type === 'Answer') {
      const label = String(c.answer.hud?.label || '').trim();
      if (label) return `${label} · ${K.HEDGE}`;
    } else if (c?.type === 'Unavailable') {
      return String(c.label || '').trim() || null;
    }
    if (s?.type === 'Answer') return String(s.answer.hud?.label || '').trim() || null;
    if (s?.type === 'Unavailable') return String(s.label || '').trim() || null;
    return null;
  }
  function ambientLineBody(c, s, cameraStale, accusation) {
    if (cameraStale) return 'Camera is not streaming';
    const action = ambientAction(c);
    if (action) return action;
    if (accusation) {
      const seat = ambientSeatLine(c);
      if (seat) return seat;
      const held = String(accusation.label || '').trim();
      if (held) return `${held} · ${K.HEDGE}`;
    }
    if (connectorClaimsLine(c)) {
      const w = accusation ? null : ambientWarning(c);
      const accused = w ? firstText(w.hud?.detail, w.hud?.label, w.summary) : null;
      const alarm = ambientSeatLine(c) || accused;
      const uncertain = answerOf(c)?.warning?.id === 'identity/uncertain';
      const notice = !alarm && !uncertain && !accusation ? ambientNotice(c) : null;
      const base = alarm || ambientText(c, s) || notice;
      if (!base) return null;
      const latency = answerOf(c)?.latencyMs;
      return !alarm && !notice && latency > 0 ? `${base} · ${latency}ms` : base;
    }
    return scenePhrase(s) || ambientNotice(c);
  }
  function ambientAlarm(c, cameraStale, accusation) {
    return !cameraStale && ambientAction(c) == null
      && (connectorClaimsLine(c) || accusation != null)
      && (ambientSeatLine(c) != null || (accusation == null && ambientWarning(c) != null));
  }
  /** The fitted sentence, without its marker. The page draws the marker. */
  function fitAmbient(body) {
    const room = K.AMBIENT_LINE_CHARS - 2;
    const clean = String(body).trim().replace(/\s+/g, ' ');
    if (clean.length <= room) return clean;
    const sentence = clean.split('.')[0].trim();
    const chosen = sentence && sentence.length <= room ? sentence : clean;
    if (chosen.length <= room) return chosen;
    const cut = chosen.slice(0, Math.max(1, room - 1));
    const space = cut.lastIndexOf(' ');
    return `${(space >= 8 ? cut.slice(0, space) : cut).replace(/[ ,;:.]+$/, '')}…`;
  }
  function ambientCandidate(c, s, cameraStale, accusation) {
    const body = ambientLineBody(c, s, cameraStale, accusation);
    if (!body) return null;
    const alarm = ambientAlarm(c, cameraStale, accusation);
    const kind = cameraStale ? 'Camera'
      : body === ambientAction(c) ? 'Action'
        : alarm ? 'Alarm'
          : 'View';
    return { text: fitAmbient(body), alarm, kind };
  }

  // ── AmbientLatch.kt ─────────────────────────────────────────────────────
  function nextAmbient(shown, candidate, nowMs) {
    if (shown && candidate && shown.text === candidate.text && shown.alarm === candidate.alarm) return shown;
    const dwell = shown?.kind === 'Action'
      ? Math.min(K.AMBIENT_DWELL_MS, K.AMBIENT_ACTION_DWELL_MS)
      : K.AMBIENT_DWELL_MS;
    const settled = !shown || nowMs - shown.sinceMs >= dwell;
    const atOnce = !shown
      || shown.kind === 'Camera'
      || candidate?.kind === 'Camera'
      || candidate?.kind === 'Action'
      || (candidate?.kind === 'Alarm' && shown.kind !== 'Alarm');
    if (!atOnce && !settled) return shown;
    return candidate ? { ...candidate, sinceMs: nowMs } : null;
  }

  /**
   * The panel at every latch tick of the clip.
   *
   * @param {object} trace a replay trace
   * @returns {{tickMs: number, frames: object[]}} one frame per tick; index
   *   with `Math.floor(t * 1000 / tickMs)`
   */
  function buildTimeline(trace) {
    const polls = (trace.polls || []).slice().sort((a, b) => a.tBack - b.tBack);
    const scenes = (trace.scenes || []).slice().sort((a, b) => a.tBack - b.tBack);
    const acks = (trace.uplinks?.at || []).map((s) => s * 1000);
    const uplinkMs = trace.cadence?.uplinkMs || 1000;
    const proc = trace.procedure || {};
    const stepLabel = String(proc.stepLabel || proc.stepCode || trace.step || '').trim();
    const step = stepLabel ? {
      position: proc.stepIndex ? (proc.totalSteps ? `STEP ${proc.stepIndex}/${proc.totalSteps}` : `STEP ${proc.stepIndex}`) : null,
      label: trimTo(stepLabel, K.HUD_BODY_LINE_CHARS * 2),
      desc: (() => {
        const d = aidFor(stepLabel, proc.stepDescription);
        return d ? trimTo(d, K.MAX_STEP_DESC_CHARS) : null;
      })(),
    } : null;

    const frames = [];
    const seen = new Set();
    let pi = -1;
    let si = -1;
    let ai = -1;
    let connector = { type: 'Idle' };
    let heldConnector = null;
    let scene = { type: 'Idle' };
    let accusation = null;
    let module = null;
    let shown = null;
    const endMs = Math.ceil((trace.durationS || 0) * 1000);
    for (let now = 0; now <= endMs; now += K.TICK_MS) {
      while (pi + 1 < polls.length && polls[pi + 1].tBack * 1000 <= now) {
        pi += 1;
        const p = polls[pi];
        const at = p.tBack * 1000;
        connector = connectorState(p);
        const a = p.answer;
        if (connector.type === 'Answer') heldConnector = connector;
        if (a && !p.error) {
          if (a.ok && (a.candidates || []).length && a.warning == null) {
            const top = a.candidates[0].className;
            if ((a.module?.connectorIds || []).includes(top)) seen.add(top);
          }
          if (a.module) {
            const recognised = (a.module.connectorIds || []).filter((id) => seen.has(id));
            module = moduleLine(a.module, recognised);
          }
          accusation = nextAccusation(accusation, a, at);
        }
      }
      while (si + 1 < scenes.length && scenes[si + 1].tBack * 1000 <= now) {
        si += 1;
        const s = scenes[si];
        scene = s.ok
          ? { type: 'Answer', answer: s, at: s.tBack * 1000 }
          : { type: 'Unavailable', label: String(s.hud?.label || '').trim() };
      }
      // Answers go stale on their own clocks.
      if (connector.type === 'Answer' && now - connector.at >= K.CONNECTOR_ANSWER_TTL_MS) connector = { type: 'Idle' };
      if (scene.type === 'Answer' && now - scene.at >= K.SCENE_ANSWER_TTL_MS) scene = { type: 'Idle' };
      if (accusation && now - accusation.lastSeenAtMs >= K.ACCUSATION_ABSENCE_MS) accusation = null;
      // A poll that failed keeps the last answer on the line for a while.
      const steady = connector.type === 'Unavailable' && heldConnector
        && now - heldConnector.at < K.AMBIENT_CONNECTOR_HOLD_MS ? heldConnector : connector;

      while (ai + 1 < acks.length && acks[ai + 1] <= now) ai += 1;
      // The glasses are already streaming when a recording starts, so the
      // moment before the replay's first upload lands is not a dead camera.
      const ackAt = acks.length
        ? (ai >= 0 ? acks[ai] : (acks[0] < uplinkMs ? 0 : null))
        : Math.floor(now / uplinkMs) * uplinkMs;
      const camAge = ackAt == null ? null : now - ackAt;
      const cameraStale = camAge == null || camAge >= K.CAMERA_STALE_MS;

      shown = nextAmbient(shown, ambientCandidate(steady, scene, cameraStale, accusation), now);
      const banner = warningBanner(accusation, module?.warning);
      frames.push({
        t: now / 1000,
        poll: pi >= 0 ? polls[pi].i : null,
        scene: si >= 0 ? si : null,
        cam: { ageMs: camAge, stale: cameraStale },
        ambient: shown ? { text: shown.text, alarm: shown.alarm, kind: shown.kind } : null,
        banner,
        step,
        // The banner takes the centre, and the card under it stands down.
        module: module && !banner ? { label: module.label, detail: module.detail } : null,
        moduleHidden: Boolean(module && banner),
      });
    }
    return { tickMs: K.TICK_MS, frames };
  }

  // ── A recording whose fitting was set by hand ───────────────────────────
  /** How long a named insertion stays on the line. radioFitting.js. */
  const FIT_NAME_HOLD_MS = 10000;
  /** The fitting line's budget after its marker. radioFitting.js. */
  const FIT_LINE_CHARS = 40;
  /**
   * The same trace, with the count and the fitting line taken from a script
   * of when each connector went in instead of from the count model.
   *
   * For a recording kept as a fixed example of the panel. A poll shows a
   * connector as in once it was sent at or past the scripted time, and words
   * the line the way `radioFitAmbient` does: the name for one, a tally for
   * several, held ten seconds. What the stack answered is kept on each poll
   * as `fillStack`, `seatingStack` and `ambientStack`.
   *
   * The connectors of the step are the scripted ones, in the order they go
   * in. An ID the stack lists for the module but the script does not is
   * dropped from the panel; the stack's list is kept as `connectorIdsStack`.
   *
   * `unseated` lists connectors that went in without being pushed home, and
   * when each was (`home`, or none if it never was). They are named the way
   * the stack names them: only once every connector is in, as
   * `unseatedPhrases`, which `moduleWarning` turns into the push-home banner.
   *
   * @param {object} trace a replay trace
   * @param {{fits: {id: string, t: number}[],
   *   unseated?: {id: string, home?: number}[]}} script
   * @param {Record<string, string>} names panel name by connector ID
   * @returns {object} a trace; `scripted.events` lists what was announced
   */
  function applyScript(trace, script, names = {}) {
    const fits = (script?.fits || []).slice().sort((a, b) => a.t - b.t);
    if (!fits.length) return trace;
    const total = fits.length;
    const order = fits.map((f) => f.id);
    const events = [];
    const loose = (script.unseated || []).map((u) => ({ id: u.id, home: u.home ?? Infinity }));
    const seats = {};
    let shown = 0;
    let recent = null;
    const polls = (trace.polls || []).map((p) => {
      const a = p.answer;
      if (!a?.module || p.error) return p;
      const seen = p.tSent;
      const inNow = fits.filter((f) => f.t <= seen);
      if (inNow.length > shown) {
        const fresh = inNow.slice(shown);
        const ids = fresh.map((f) => f.id);
        const name = ids.length === 1 ? String(names[ids[0]] || '').trim() : '';
        const named = name ? `fitting · ${name} in` : '';
        const line = named && named.length <= FIT_LINE_CHARS
          ? named
          : (ids.length > 1 ? `fitting · ${ids.length} more in` : `fitting the ${String(a.module.name || '').toLowerCase()}`);
        shown = inNow.length;
        recent = { line, connector: line === named ? 'named' : (ids.length > 1 ? 'tally' : null), atMs: p.tBack * 1000 };
        events.push({ ids, n: shown, line, linePoll: p.i, lineT: p.tBack, fitT: fresh[fresh.length - 1].t });
      }
      // Not home is held back until every connector is in, as on the stack.
      const notHome = shown >= total ? loose.filter((u) => seen < u.home).map((u) => u.id) : [];
      for (const u of loose) {
        const up = notHome.includes(u.id);
        if (up && !seats[u.id]) seats[u.id] = { id: u.id, raisedT: p.tBack, homeT: null, pushedT: Number.isFinite(u.home) ? u.home : null };
        else if (!up && seats[u.id] && seats[u.id].homeT == null) seats[u.id].homeT = p.tBack;
      }
      const stack = a.module.fill || null;
      const fill = {
        ...(stack || {}),
        decidable: true,
        held: null,
        heldAgeMs: 0,
        fitted: shown,
        total,
        reason: `${shown} of ${total} fitted`,
        ageMs: 0,
        openPhrases: [],
        unseatedPhrases: notHome.map((id) => String(names[id] || id)),
        unseatedIds: notHome,
        unseatedAmbiguous: false,
        scripted: true,
      };
      // The stack's seat read stands down with its count: one story on the panel.
      const seatingStack = a.module.seating || null;
      const seating = { decidable: false, reason: seatingStack?.reason || '' };
      let ambient = null;
      if (recent && p.tBack * 1000 - recent.atMs <= FIT_NAME_HOLD_MS) {
        ambient = { line: recent.line, source: 'script', stage: 'fitting', connector: recent.connector, ageMs: p.tBack * 1000 - recent.atMs };
      } else if (shown < total && /^fitting/.test(String(a.action?.className || ''))) {
        // Between insertions the action read carries the line, as on the stack.
        ambient = { line: `fitting the ${String(a.module.name || '').toLowerCase()}`, source: 'script', stage: 'fitting', connector: null, ageMs: null };
      }
      return {
        ...p,
        answer: {
          ...a,
          module: {
            ...a.module,
            connectorIds: order,
            connectorIdsStack: a.module.connectorIds || [],
            offRowIds: [],
            total,
            fill,
            fillStack: stack,
            seating,
            seatingStack,
          },
          ambient,
          ambientStack: a.ambient || null,
        },
      };
    });
    return {
      ...trace,
      polls,
      scripted: { setBy: script.setBy || 'hand', note: script.note || '', fits, order, events, total, seats: Object.values(seats) },
    };
  }

  function cameraLabel(ageMs) {
    if (ageMs == null) return 'cam off';
    if (ageMs >= 10000) return `cam ${Math.floor(ageMs / 1000)}s`;
    const tenths = Math.floor(ageMs / 100);
    return `cam ${Math.floor(tenths / 10)}.${tenths % 10}s`;
  }

  const api = { K, buildTimeline, applyScript, cameraLabel, hudConnector, moduleLine, warningBanner, fitLine, wrapLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.EmotivHud = api;
}(typeof window !== 'undefined' ? window : globalThis));
