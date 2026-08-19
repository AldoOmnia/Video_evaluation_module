/**
 * Comer platform — shared browser helpers.
 *
 * Small utilities that every page needs and that had been copy-pasted into
 * each one: HTML escaping, the language and tone preferences, currency
 * formatting, and the live-line intent routing.
 *
 * Load it SYNCHRONOUSLY in <head>, before the page's own inline <script>:
 *
 *   <script src="/lab/assets/platform.js?v=1"></script>
 *
 * Not deferred on purpose. The inline page scripts call these at parse time
 * (session gates redirect immediately), so they must already exist.
 *
 * Exposed as window.Platform, plus a few bare globals (esc, eur) because the
 * inline scripts call them unqualified in dozens of places.
 */
(function () {
  'use strict';

  /* ── HTML escaping ────────────────────────────────────────────────────── */
  /** Escape for interpolation into innerHTML. Every string that reaches the
   *  DOM from an API response or user input goes through this. */
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ── Formatting ───────────────────────────────────────────────────────── */
  /** Savings figures. Grouping stays en-US on purpose so the thousands
   *  separator matches the rest of the report chrome in both languages. */
  const eur = (n) => '€' + Number(n || 0).toLocaleString('en-US');

  /* ── Language ─────────────────────────────────────────────────────────── */
  const LANG_KEY = 'omnia.lang';
  const getLang = () => (localStorage.getItem(LANG_KEY) === 'it' ? 'it' : 'en');

  /* ── Response register ────────────────────────────────────────────────── */
  const TONES = ['enterprise', 'technical', 'coaching'];
  /** Set on /settings (omnia.settings.tone) and sent with every LLM request.
   *  Defaults to 'enterprise' because that is what the settings page shows as
   *  selected when nothing is stored — returning undefined here would mean the
   *  UI claimed a register the backend never actually applied. */
  const getTone = () => {
    try {
      const t = (JSON.parse(localStorage.getItem('omnia.settings') || '{}') || {}).tone;
      return TONES.includes(t) ? t : 'enterprise';
    } catch {
      return 'enterprise';
    }
  };

  /* ── Session ──────────────────────────────────────────────────────────── */
  const SESSION_KEY = 'omnia.session';
  /** The stored session blob, or null when absent/expired/corrupt. */
  const getSession = () => {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      if (!s || !s.expiresAt || new Date(s.expiresAt) < new Date()) return null;
      return s;
    } catch {
      return null;
    }
  };
  /** Gate a page: returns the session, or redirects to login and returns null.
   *  Call at the top of an inline script, before rendering anything. */
  const requireSession = () => {
    const s = getSession();
    if (!s) location.replace('/login/');
    return s;
  };

  /* ── Intent routing ───────────────────────────────────────────────────── */
  /* Three destinations: the MES (POST /api/line/ask), the glasses warnings
   * report, and the knowledge corpus. Both the home chat and the Comer AI dock
   * route with these, so the vocabulary lives here — it used to be duplicated
   * in both files and had to be edited twice.
   *
   * The split used to be "is this about right now?", which was correct when the
   * MES path could only read a live snapshot. It now answers over the whole
   * database — shift counts, per-serial history, measurements against limits,
   * week-over-week failures — so the question became "is this a fact the
   * database records, or tribal knowledge about how to do the job?"
   *
   * Getting this wrong is not a crash, it is the wrong data source answering
   * confidently, so every change here needs a case in tools/test-routing.mjs.
   */

  /* Asks how or why the work is done, or for guidance. Tribal knowledge. */
  const KB_INTENT_RE = /(how\s+(?:do|does|should|can|would|did)\s+(?:i|we|you|they)\b|how\s+to\b|why\s+(?:do|does|did|is|are|would)\b|what\s+causes|root\s+cause|best\s+practice|common\s+(?:mistake|error|issue|problem|failure)s?\b|most\s+common|tribal|\btips?\b|\badvice\b|\bprevent\b|\bavoid(?:ing)?\b|troubleshoot|correct\s+way|right\s+way|step[-\s]by[-\s]step|come\s+si\b|come\s+faccio|perch[eé]\b|buone\s+pratiche|(?:errori|problemi)\s+(?:pi[uù]\s+)?comuni|consigl\w*|procedur\w*|istruzion\w*)/i;

  /* Topics that only exist as tribal knowledge. These veto the data path
     unless the question is pinned to a time window (see isDataQuestion). */
  const KB_TOPIC_RE = /\b(shim|shimming|bearing|pinion|yoke|orientation|orient\w*|preload|loctite|torque\s+spec\w*|tightening|mistake|cuscinett\w*|orientament\w*|\bcoppia\b|sequenza|montagg\w*|spessor\w*)\b/i;

  /* Counting, aggregation, ranking, comparison — all database work. "most" is
     deliberately absent: it collides with "most common mistakes". */
  const MES_METRIC_RE = /(how\s+many|how\s+much|\bcount\b|number\s+of|\btotal\b|average|\bavg\b|throughput|produced|\bbuilt\b|\boutput\b|compare[d]?\b|\bversus\b|\bvs\.?\b|breakdown|rank\w*|top\s+\d|highest|lowest|slowest|fastest|quant[ie]\b|\btotale\b|\bmedia\b|prodott\w*|confront\w*|classific\w*|maggior\w*)/i;

  /* A bounded period. Only the database can answer these. */
  const MES_TIME_RE = /(right\s+now|\bnow\b|currently|\btoday\b|\byesterday\b|this\s+(?:week|month|shift|morning|afternoon)|last\s+\d+\s*(?:min\w*|hour|day|week)|last\s+(?:week|month|shift|hour)|past\s+\d+|so\s+far|(?:more\s+than|over|longer\s+than|at\s+least|within)\s+(?:an?|\d+)\s*(?:min\w*|hour|day|week)|adesso|in\s+questo\s+momento|al\s+momento|in\s+corso|\bora\b|\boggi\b|\bieri\b|quest[ao]\s+(?:settimana|mese|turno)|ultim[eio]\s*\d*|pi[uù]\s+di\s+(?:un\w*|\d+)\s*(?:minut\w*|or[ae]|giorn\w*))/i;

  /* Objects the MES records. */
  const MES_NOUN_RE = /(\bline\b|\blinea\b|\bstations?\b|\bstazion\w*|\bworkers?\b|technician|\btecnico\b|\boperator(?:s|e|i)?\b|\bbadge\b|\bunits?\b|\bunit[aà]\b|\bpezz\w*|\bphases?\b|\bfas[ei]\b|\bserials?\b|\bseriale\b|matricola|measurement|misur\w*|reading|\blimits?\b|out\s+of\s+(?:spec|limit)|fuori\s+(?:limite|specifica)|not\s+ok|\bnok\b|\bscrap\b|scart\w*|fail(?:ure|ed|s|ing)?\b|pass\s+rate|cycle\s+time|tempo\s+ciclo|\bshift\b|\bturno\b|downtime|\bidle\b|\bferm[oa]\b)/i;

  /* A station called out by number, in any of the forms the plant uses. */
  const MES_STATION_RE = /(\bst\s?\d{2,3}\b|\bstation\s+\d+|\bstazione\s+\d+|\bpg-?\d+)/i;

  /* Unambiguous MES phrasings — these route on their own. */
  const MES_STRONG_RE = /(\bmes\b|unicomm|fargo|workstation|live\s*line|linea\s*live|line\s+status|stato\s+(?:della\s+)?linea|what(?:'s|s| is)?\s+happening|cosa\s+(?:sta\s+)?succede|che\s+(?:cosa\s+)?succede|chi\s+sta\s+lavorando|who(?:'s|s| is)?\s+working|quale\s+operatore|which\s+operator|\bserials?\b|\bseriale\b|matricola|\bsessione\b|a\s+che\s+fase|what\s+step\s+(?:are|is)|current\s+step|fase\s+(?:corrente|in\s+corso)|(?:what|which|list|show)\s+(?:me\s+)?(?:the\s+)?phases\b|quali\s+fasi)/i;

  /** True when the question asks for something the MES database records. */
  const isLineQuestion = (q) => {
    if (MES_STRONG_RE.test(q)) return true;
    const timed = MES_TIME_RE.test(q);
    const subject = MES_NOUN_RE.test(q) || MES_STATION_RE.test(q);
    /* A time window plus a MES object outranks procedural phrasing: "why did
       ST150 fail this week" wants the record, not the tribal answer. Without a
       window, "how do I..." and shim/bearing/torque talk stay on the corpus. */
    if (KB_INTENT_RE.test(q) || KB_TOPIC_RE.test(q)) return timed && subject;
    return (MES_METRIC_RE.test(q) || timed) && subject;
  };

  /* The report card is its own destination. Deliberately phrase-based rather
   * than keyword-based: a bare "warning" or "glasses" is usually a knowledge
   * question ("what warning fires on the big cup?"), not a request for the
   * savings dashboard. */
  const REPORT_RE = /(warnings?\s+report|glasses\s+report|report\s+(?:degli?\s+)?avvisi|report\s+occhiali|avvisi\s+occhiali|\bsavings\b|risparmi\w*|\brework\b|rilavorazion\w*|\bavoided\b|evitat\w*)/i;

  /** Three-way route used by the home chat. The dock only needs the line/KB
   *  split because it has no report surface of its own, so both surfaces share
   *  isLineQuestion() and can no longer disagree. */
  const routeOf = (q) => {
    if (REPORT_RE.test(q)) return 'report';
    if (isLineQuestion(q)) return 'line';
    return 'brain';
  };

  window.Platform = {
    esc,
    eur,
    LANG_KEY,
    getLang,
    getTone,
    TONES,
    getSession,
    requireSession,
    line: {
      KB_INTENT_RE,
      KB_TOPIC_RE,
      MES_METRIC_RE,
      MES_TIME_RE,
      MES_NOUN_RE,
      MES_STATION_RE,
      MES_STRONG_RE,
      REPORT_RE,
      isLineQuestion,
      routeOf,
    },
  };

  // The inline page scripts call these unqualified in many places.
  window.esc = esc;
  window.eur = eur;
})();
