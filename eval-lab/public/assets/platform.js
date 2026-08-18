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

  /* ── Live-line intent routing ─────────────────────────────────────────── */
  /* Questions about what the MES is reporting *right now* go to
   * POST /api/line/ask; everything else goes to the knowledge corpus. Both the
   * home chat and the Comer AI dock route with these, so the vocabulary lives
   * here — it used to be duplicated in both files and had to be edited twice.
   *
   * Knowledge phrasings ("most common mistakes on the line") deliberately stay
   * on the KB path: mentioning "the line" is not a request for a live reading.
   */
  const LINE_STRONG_RE = /(\bmes\b|unicomm|fargo|workstation|live\s*line|linea\s*live|line\s+status|stato\s+(?:della\s+)?linea|what(?:'s|s| is)?\s+happening|cosa\s+(?:sta\s+)?succede|che\s+(?:cosa\s+)?succede|chi\s+sta\s+lavorando|who(?:'s|s| is)?\s+working|quale\s+operatore|which\s+operator|serial\s*number|\bseriale\b|matricola|\bsessione\b|a\s+che\s+fase|what\s+step\s+(?:are|is)|current\s+step|fase\s+(?:corrente|in\s+corso))/i;
  const LINE_KB_RE = /\b(mistake|mistakes|defect|torque|shim|bearing|pinion|orientation|procedure|tribal|errore|errori|difett\w*|coppia|orientament\w*|procedur\w*|consigl\w*)\b/i;
  const LINE_NOW_RE = /(right\s+now|\bnow\b|currently|adesso|in\s+questo\s+momento|al\s+momento|in\s+corso|\bora\b|\btoday\b|\boggi\b)/i;
  /* "operator" covers en/it singular and plural in one alternation: the
     English form was previously missing while "operatore" was present, so
     "what is the operator doing right now" read as knowledge in English and as
     a live reading in Italian. */
  const LINE_SUBJ_RE = /(\bline\b|\blinea\b|\bstation\b|\bstazione\b|\bworkers?\b|technician|\btecnico\b|\boperator(?:s|e|i)?\b|\bunit\b|\bunità\b|\bpezzo\b)/i;
  /** True when the question asks for a live MES reading. */
  const isLineQuestion = (q) =>
    LINE_STRONG_RE.test(q) ||
    (!LINE_KB_RE.test(q) && LINE_NOW_RE.test(q) && LINE_SUBJ_RE.test(q));

  /* The report card is its own destination. Deliberately phrase-based rather
   * than keyword-based: a bare "warning" or "glasses" is usually a knowledge
   * question ("what warning fires on the big cup?"), not a request for the
   * savings dashboard. */
  const REPORT_RE = /(warnings?\s+report|glasses\s+report|report\s+(?:degli?\s+)?avvisi|report\s+occhiali|avvisi\s+occhiali|\bsavings\b|risparmi\w*|\brework\b|rilavorazion\w*|\bavoided\b|evitat\w*)/i;

  /** Three-way route used by the home chat. The dock only needs the line/KB
   *  split because it has no report surface of its own, so both surfaces share
   *  isLineQuestion() and can no longer disagree.
   *
   *  This fixed a real divergence: home used to gate the weak line signals on a
   *  much broader knowledge vocabulary that included "operator", "step",
   *  "part" and "component". "What is the operator doing right now" therefore
   *  reached the knowledge base from the home chat but the MES from the dock.
   *  LINE_KB_RE keeps only genuinely tribal-knowledge topics, so that question
   *  now correctly reads the line on both. */
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
      LINE_STRONG_RE,
      LINE_KB_RE,
      LINE_NOW_RE,
      LINE_SUBJ_RE,
      REPORT_RE,
      isLineQuestion,
      routeOf,
    },
  };

  // The inline page scripts call these unqualified in many places.
  window.esc = esc;
  window.eur = eur;
})();
