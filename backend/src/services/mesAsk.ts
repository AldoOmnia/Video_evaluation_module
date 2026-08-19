/**
 * Natural-language questions answered directly from the UNICOMM MES database.
 *
 * Two passes, deliberately:
 *
 *   1. PLAN — the model sees the real schema and writes one SELECT, or declines
 *      because the question is not a database question.
 *   2. ANSWER — the model sees the rows that query actually returned and writes
 *      prose. It never sees the database, only results.
 *
 * Splitting them is what keeps this honest. A single pass invites a model to
 * describe rows it hopes exist; here the numbers in the answer came out of the
 * database on this request, and when the query returns nothing the answer has to
 * say so. The schema is injected from INFORMATION_SCHEMA rather than described
 * in prose, because an invented column name is the most common failure mode of
 * text-to-SQL and the cheapest one to design out.
 *
 * Time is pre-bound rather than left to the model: `Phase_Date` holds Rockford
 * wall-clock digits while the database host's clock is Italian, so any query
 * built on GETDATE() silently filters the wrong window. The planner is given
 * bound parameters and forbidden from reaching for the server clock.
 */
import { llmCall } from "./anthropic.js";
import {
  MAX_ROWS,
  PLANT_TZ,
  assertReadOnly,
  fetchLineSnapshot,
  mesConfig,
  mesQuery,
  mesSchema,
  plantClock,
  plantWallClockAsDbDate,
  schemaForPrompt,
} from "./mesSql.js";
import {
  MES_STATION_NUMBERS,
  coverageForPrompt,
  isTrainedMesStation,
  stationForMesNumber,
  topologyForPrompt,
} from "./stations.js";

/** Rows shown to the answering model. Below MAX_ROWS to bound prompt cost;
 *  aggregates are what answer most questions, not long row dumps. */
const ROWS_TO_MODEL = 40;

/**
 * The line's stations by MES number, so the planner knows what exists.
 *
 * Without this the model can only discover stations by querying, and it guesses
 * at which numbers are real — the roster makes "which station is the shimming
 * cell" answerable without a round trip, and stops ST100 being treated as the
 * whole plant.
 */
function mesStationRoster(): string {
  return MES_STATION_NUMBERS.map((n) => {
    const s = stationForMesNumber(n);
    const trained = isTrainedMesStation(n) ? "  [procedure trained]" : "";
    return `  ${n} → ${s ? `${s.label} · ${s.stage}` : "unknown station"}${trained}`;
  }).join("\n");
}

export interface MesAskResult {
  answer: string;
  /** The SELECT that produced the numbers, for the "show me why" affordance. */
  sql: string | null;
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
  /** Set when the planner declined or the query failed, for logs and the UI. */
  note?: string;
}

interface Plan {
  needs_sql: boolean;
  sql?: string;
  reason?: string;
}

function plannerPrompt(schema: string, cfg: ReturnType<typeof mesConfig>): string {
  return [
    "You translate a plant manager's question into ONE read-only SQL Server SELECT",
    "against Comer Industries' UNICOMM MES database (SSL04_FARGO).",
    "",
    "SCOPE — the WHOLE Rockford line, every station. Do NOT restrict a query to one",
    "station unless the question names one. If the question is about 'the line',",
    "'the plant', 'today', 'which station…', query across all stations.",
    "",
    "STATIONS ON THIS LINE (MES Station_Number → what it is):",
    mesStationRoster(),
    `Station_Number ${cfg.stationNumber} is merely the platform's DEFAULT for a bare`,
    "'the station' with no other context — it is NOT a filter to apply by habit.",
    "",
    topologyForPrompt(),
    "",
    "Reply with ONLY a JSON object, no prose, no markdown fence:",
    '  {"needs_sql": true, "sql": "SELECT ..."}',
    '  {"needs_sql": false, "reason": "why this needs no database query"}',
    "",
    "HARD RULES:",
    "- SELECT only. No INSERT/UPDATE/DELETE/DDL, no stored procedures, no",
    "  SELECT ... INTO, no multiple statements, no semicolon-separated queries.",
    "- Always bound the result: use TOP (n) with n <= 200, or aggregate.",
    "- Use ONLY tables and columns from the schema below. Never invent a column.",
    "- Prefer aggregates (COUNT, AVG, MIN, MAX, GROUP BY) over dumping rows —",
    "  the answer is usually a number, not a list.",
    "",
    "TIME — this matters and is easy to get wrong:",
    "- SSL_ResPhase.Phase_Date holds PLANT-LOCAL wall-clock time",
    `  (${PLANT_TZ}). The database server's own clock is in a different`,
    "  timezone entirely, so GETDATE(), SYSDATETIME() and CURRENT_TIMESTAMP are",
    "  ALL WRONG for filtering Phase_Date. Never use them.",
    "- 'RIGHT NOW' / 'currently' / 'adesso' MUST be a bounded window, normally",
    "  DATEADD(minute, -30, @plantNow). Taking the latest row per station with no",
    "  lower bound is WRONG: it returns stations whose last phase was yesterday and",
    "  presents them as running. Always bound the window for present-tense questions.",
    "- Use these pre-bound parameters instead:",
    "    @plantNow      — now, in plant wall-clock terms",
    "    @plantToday    — midnight today, plant local (use for 'today', 'this shift')",
    "    @plant24hAgo   — 24 hours ago, plant local",
    "    @plant7dAgo    — 7 days ago, plant local",
    `    @station       — the default station number (${cfg.stationNumber})`,
    `    @testNumber    — the tracked test program ('${cfg.testNumber}')`,
    "  Example: WHERE Phase_Date >= @plantToday",
    "- You may use DATEADD/DATEDIFF relative to those parameters.",
    "",
    "SQL SERVER QUIRKS IN THIS DATABASE:",
    "- Columns typed `text` (marked in the schema) are a legacy type that CANNOT",
    "  be used in GROUP BY, ORDER BY, DISTINCT, =, or JOIN conditions. Wrap them:",
    "  CAST(st.Station_Name AS nvarchar(200)). This applies to most descriptive",
    "  columns here, including Station_Name and Phase_Description.",
    "- Bracket reserved words used as column names: [min], [max].",
    "",
    "IDENTIFYING A PRODUCT OR MODEL — read this before answering any question",
    "that names an axle model (425, Quad Track, Large Wheel, Small Wheel, 600…):",
    "- There is NO model or product column anywhere in this schema.",
    "  Production_Manager would hold Model but is EMPTY (0 rows).",
    "- Serial numbers (SSL_ResPhase.SN, e.g. 'PCMRS0700653') are SEQUENTIAL and",
    "  carry NO model information whatsoever. NEVER match a model number against",
    "  SN. 'SN LIKE %425%' is ALWAYS WRONG: it matches serial PCMRS0700425, which",
    "  is simply the 425th unit built and has nothing to do with the 425 axle.",
    "  This exact mistake has produced confidently wrong answers — do not repeat it.",
    "- Product identity comes from the TEST PROGRAM. The chain is:",
    "    SSL_Test.Description  (e.g. 'Small Wheel - 425', 'QUAD TRACK 600 FRONT')",
    "      → SSL_Test.Test_Number      (e.g. 'X900.SWR.901.A01')",
    "      → SSL_Phase.Phase_ID        (the phases that program publishes,",
    "                                   e.g. '4900.12001 P100 RING RETAINER')",
    "      → SSL_ResPhase.Phase_ID     (what the line actually wrote)",
    "- So to answer 'was model X running at station S?', find the Test_Numbers",
    "  whose Description matches X, take their published Phase_IDs at station S",
    "  from SSL_Phase, and look for THOSE Phase_IDs in SSL_ResPhase. A single",
    "  query with a subquery or join does this — do not guess a shortcut.",
    "- Some stations name the model directly in the phase, e.g. ST190 writes",
    "  '190_Run-in 425'. Matching Phase_ID on the model name is therefore valid;",
    "  matching SN on it never is.",
    "- CRITICAL: many phase names are GENERIC and published by SEVERAL programs",
    "  ('P100 FEELER GAUGE', 'P100 FEELER GAUGE SNAP RING'). Finding one of those",
    "  in SSL_ResPhase does NOT show the target model was running. Restrict to",
    "  phases published by the target program AND BY NO OTHER, i.e. add:",
    "    AND sp.Phase_ID NOT IN (SELECT Phase_ID FROM dbo.SSL_Phase",
    "                            WHERE Station_Number = <station>",
    "                              AND Test_Number NOT IN (<the target programs>))",
    "  Model-specific phases carry a program prefix (e.g. '4900.12001 …' belongs",
    "  only to the two 425 programs), which is what makes the answer decisive.",
    "",
    "DOMAIN NOTES:",
    "- SSL_ResPhase is the record of what happened; SSL_Phase is the published",
    "  procedure definition. 'What happened' questions use SSL_ResPhase.",
    "- Station scoping comes from SSL_ResPhase.Station_Number. Production_Manager",
    "  has no Station_Number — join it by SN when you need Model/OP.",
    "- Operator_ID in SSL_ResPhase matches SSL_Users.UserName (or UserID as text).",
    "- Measurements live in SSL_ResPhase1: Value_Acq against [min]/[max], with",
    "  Status_Acq as the pass/fail flag. Bracket [min] and [max] — reserved words.",
    "- A failure/reject is Phase_Result indicating not-OK, or Status_Acq failing.",
    "  Inspect distinct values rather than assuming a specific code.",
    "",
    "SCHEMA:",
    schema,
  ].join("\n");
}

function answerPrompt(lang: "en" | "it"): string {
  return [
    "You are the MES assistant for Comer Industries' Rockford axle line. You",
    "answer questions from plant directors using ONLY the query results supplied.",
    "",
    "HARD RULES:",
    "- The rows given to you came from the live MES on this request. Report them",
    "  as fact, but NEVER add a number that is not in them.",
    "- This MES holds no shift schedule, planned hours, or production target. Do",
    "  not say how much of the shift is left, whether output is ahead or behind",
    "  plan, or project an end-of-day figure. Compare only the numbers in the rows.",
    "- A unit count is only meaningful with the station it was counted at, and the",
    "  column name carries it: units_completed_at_190 is finished axles leaving the",
    "  line, a count with no station filter is serials touched anywhere and is NOT",
    "  output. Say which one you are reporting — 'X units completed at end of line",
    "  (ST190)' — so two counts can never be read as the same measure.",
    "- If the result set is empty, say plainly that nothing matched what was",
    "  searched, and say what that was. Do NOT invent a reason — never guess that",
    "  'the station may be offline or waiting on material'. You MAY, and should,",
    "  use the live line state below to say what the station IS doing instead: an",
    "  empty result plus a known current phase is a complete answer ('no, ST100 is",
    "  on <phase> for serial <x>'). Only disclaim knowing the state if the line",
    "  state genuinely does not cover that station.",
    "- Timestamps shown are PLANT-LOCAL floor time. Never call them UTC and never",
    "  convert them. Prefer 'x minutes ago' phrasing where an age is given.",
    "- A station is only RUNNING if its last activity is recent — minutes, not",
    "  hours. If a row's last activity is hours old or from a previous day, that",
    "  station is IDLE and must be described that way ('last seen yesterday at",
    "  14:19'). Never list a station as active on the strength of a stale row, and",
    "  never total up stale rows into a count of stations 'running right now'.",
    "- Keep MES vocabulary exact: station numbers (ST100), phase ids, serials,",
    "  part numbers, Nm/mm units, UNICOMM, SSL04_FARGO.",
    coverageForPrompt(),
    "",
    "- Operator identity in this plant is a badge number (Operator_ID, e.g. 2406).",
    "  Names are not recorded anywhere in this MES, so say 'operator 2406' and do",
    "  NOT remark on the name being missing — nothing is broken.",
    "- Never quote raw column names or SQL at the director. Say what the value",
    "  means in plant language.",
    "- Do not narrate your inputs. Never write 'the query results show', 'the",
    "  data provided', 'according to the snapshot' — just state the fact. The",
    "  director wants the number, not a description of where it sat.",
    "- Be concise and decision-ready: 1-4 sentences. Use a short list only when",
    "  naming more than three values.",
    "- Answer the question that was asked. If it is a yes/no question, LEAD with",
    "  the yes or no, then the supporting fact — do not report adjacent state and",
    "  leave the director to infer the answer.",
    "- Reply in plain text, not JSON or markdown.",
    "",
    lang === "it"
      ? "LINGUA: rispondi in ITALIANO, registro tecnico da stabilimento. Lascia invariati numeri di stazione, id fase, seriali, part number, MES/UNICOMM/SSL04_FARGO e le unità di misura."
      : "LANGUAGE: reply in English.",
  ].join("\n");
}

/** Strip a ```json fence if the model adds one despite instructions. */
function parsePlan(text: string): Plan | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Plan;
  } catch {
    return null;
  }
}

/**
 * Render values for the answering model: Date columns become plant wall-clock
 * strings so the model cannot mislabel them, and nothing arrives as a raw UTC
 * ISO string that invites a timezone claim.
 */
function renderRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.slice(0, ROWS_TO_MODEL).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Date) {
        out[k] = plantClock(v);
      } else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
        out[k] = plantClock(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  });
}

type PlannedRun =
  | { ok: true; sql: string; rows: Record<string, unknown>[]; truncated: boolean; elapsedMs: number }
  | { ok: false; sql: string; note: string };

/** Guard, then execute. Never throws — the caller decides whether to repair. */
async function runPlanned(
  sqlText: string,
  params: Record<string, string | number | Date>,
): Promise<PlannedRun> {
  try {
    assertReadOnly(sqlText);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      sql: sqlText,
      note: `rejected by the read-only guard: ${reason}`,
    };
  }
  try {
    const res = await mesQuery(sqlText, params);
    return {
      ok: true,
      sql: sqlText,
      rows: res.rows as Record<string, unknown>[],
      truncated: res.truncated,
      elapsedMs: res.elapsedMs,
    };
  } catch (e) {
    return {
      ok: false,
      sql: sqlText,
      note: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Time and station parameters every planned query may reference. */
function boundParams(): Record<string, string | number | Date> {
  const now = new Date();
  const cfg = mesConfig();
  const plantNow = plantWallClockAsDbDate(now);
  // Midnight today in plant terms: zero the clock on the plant-local digits.
  const midnight = new Date(plantNow);
  midnight.setUTCHours(0, 0, 0, 0);
  return {
    plantNow,
    plantToday: midnight,
    plant24hAgo: plantWallClockAsDbDate(new Date(now.getTime() - 24 * 3600_000)),
    plant7dAgo: plantWallClockAsDbDate(new Date(now.getTime() - 7 * 24 * 3600_000)),
    station: cfg.stationNumber,
    testNumber: cfg.testNumber,
  };
}

/**
 * Answer a natural-language question from the MES database.
 *
 * Default grounding is the WHOLE line, not one station. `context` adds any extra
 * grounding the caller already has on screen (e.g. the station card), but it is
 * supplementary — a plant director asking "what's happening" means the line.
 */
export async function askMes(
  question: string,
  lang: "en" | "it" = "en",
  context?: Record<string, unknown> | null,
): Promise<MesAskResult> {
  const cfg = mesConfig();
  const [schemaTables, lineSnapshot] = await Promise.all([
    mesSchema(),
    // Cheap (one query) and answers a large share of questions outright, so it
    // is worth having in hand before the planner decides anything.
    fetchLineSnapshot(lang).catch(() => null),
  ]);
  const schema = schemaForPrompt(schemaTables);

  /* Hand the planner the line's current state. Many questions ("which stations
     are running", "what is the line doing") are fully answered by it, and the
     planner can then decline SQL instead of re-deriving what we already hold. */
  const plan = await llmCall({
    route: "mes-ask",
    system: plannerPrompt(schema, cfg),
    user: [
      `QUESTION: ${question}`,
      ...(lineSnapshot
        ? [
            "",
            `LINE STATE ALREADY IN HAND (last ${lineSnapshot.window_minutes} min, ` +
              `${lineSnapshot.active_station_count} station(s) active). If this fully answers` +
              " the question, reply needs_sql:false and say so in reason:",
            JSON.stringify(lineSnapshot, null, 2),
          ]
        : []),
    ].join("\n"),
    maxTokens: 700,
  });

  const parsed = parsePlan(plan.text);
  if (!parsed) {
    return {
      answer:
        lang === "it"
          ? "Non ho potuto tradurre la domanda in una query sul MES. Riformulala indicando stazione, periodo o seriale."
          : "I could not turn that into a MES query. Try naming a station, a time window or a serial.",
      sql: null,
      rowCount: 0,
      truncated: false,
      elapsedMs: 0,
      note: "planner returned unparseable output",
    };
  }

  let rows: Record<string, unknown>[] = [];
  let truncated = false;
  let elapsedMs = 0;
  let usedSql: string | null = null;
  let note: string | undefined;

  if (parsed.needs_sql && parsed.sql) {
    const attempt = await runPlanned(parsed.sql, boundParams());

    if (attempt.ok) {
      usedSql = attempt.sql;
      rows = attempt.rows;
      truncated = attempt.truncated;
      elapsedMs = attempt.elapsedMs;
    } else {
      /* One repair pass. SQL Server's errors are specific enough to act on
         ("cannot group a text column", "invalid column name"), and a model that
         sees the actual error usually fixes it. Exactly one retry: beyond that
         it tends to thrash, and a wrong answer is worse than an honest miss. */
      // eslint-disable-next-line no-console
      console.warn(`[mes-ask] ${attempt.note} — attempting repair\n  sql: ${parsed.sql}`);

      const repair = await llmCall({
        route: "mes-ask",
        system: plannerPrompt(schema, cfg),
        user: [
          `QUESTION: ${question}`,
          "",
          "Your previous query failed. Fix it and return the corrected JSON.",
          `PREVIOUS SQL: ${parsed.sql}`,
          `ERROR: ${attempt.note}`,
        ].join("\n"),
        maxTokens: 700,
      });

      const repaired = parsePlan(repair.text);
      const second =
        repaired?.needs_sql && repaired.sql
          ? await runPlanned(repaired.sql, boundParams())
          : null;

      if (second?.ok) {
        usedSql = second.sql;
        rows = second.rows;
        truncated = second.truncated;
        elapsedMs = second.elapsedMs;
        note = `first query failed (${attempt.note}), repaired on retry`;
      } else {
        // Report the failure rather than answering around it: "the database
        // said no" is useful, a confident guess is not.
        note = second?.note ?? attempt.note;
        // eslint-disable-next-line no-console
        console.warn(`[mes-ask] repair failed: ${note}`);
        return {
          answer:
            lang === "it"
              ? "Non sono riuscito a interrogare il MES per questa domanda, quindi non ho un dato da riportare. Riprova precisando stazione o periodo."
              : "I could not query the MES for that, so I have no figure to report. Try again naming a station or a time window.",
          sql: second?.sql ?? parsed.sql,
          rowCount: 0,
          truncated: false,
          elapsedMs: 0,
          note,
        };
      }
    }
  } else {
    note = parsed.reason ? `planner declined: ${parsed.reason}` : "planner declined";
  }

  const answer = await llmCall({
    route: "mes-ask",
    system: answerPrompt(lang),
    user: [
      `QUESTION: ${question}`,
      "",
      `MES: ${cfg.database} on ${cfg.host}, station ${cfg.stationNumber}, plant timezone ${PLANT_TZ}.`,
      `Plant floor local time right now: ${plantClock(plantWallClockAsDbDate())}.`,
      "",
      usedSql
        ? `QUERY RESULTS (${rows.length} row(s)${truncated ? `, capped at ${MAX_ROWS}` : ""}):\n${JSON.stringify(renderRows(rows), null, 2)}`
        : /* Hand over WHY no query ran. Without it the answer can only deflect
             ("ask your administrator"), when the useful reply is what this MES
             does and does not store — e.g. it has phase results and
             measurements but no planned time or unit costs, so OEE and scrap
             cost simply cannot be computed from it. */
          [
            "NO database query was run for this question.",
            parsed.reason
              ? `REASON (from the query planner, which saw the full schema): ${parsed.reason}`
              : "",
            "Explain to the director, in plant language, what this MES does not",
            "hold that the question needs. Be specific and definitive — do not",
            "suggest the data might exist elsewhere unless that is stated above,",
            "and do not tell them to ask an administrator to run the same query.",
          ]
            .filter(Boolean)
            .join("\n"),
      ...(lineSnapshot
        ? [
            "",
            `CURRENT STATE OF THE WHOLE LINE (last ${lineSnapshot.window_minutes} minutes) —` +
              " use this freely, it is live:",
            JSON.stringify(lineSnapshot, null, 2),
          ]
        : []),
      ...(context
        ? [
            "",
            "The station card currently on the user's screen (supplementary — do NOT",
            "treat it as the scope of the question, and do not remark that it shows a",
            "different station than the one asked about):",
            JSON.stringify(context, null, 2),
          ]
        : []),
    ].join("\n"),
    /* Sized for the longest legitimate answer, not the typical one. Plant-wide
       questions ("what is happening on the line") enumerate a dozen stations,
       and a reply cut off mid-station is worse than a verbose one. Italian runs
       longer than English for the same content. */
    maxTokens: lang === "it" ? 1200 : 900,
  });

  return {
    answer: answer.text.trim(),
    sql: usedSql,
    rowCount: rows.length,
    truncated,
    elapsedMs,
    note,
  };
}
