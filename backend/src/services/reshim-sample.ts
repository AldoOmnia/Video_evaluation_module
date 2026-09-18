/**
 * Sample (invented) reshim runs, for demos and for exercising the email path.
 *
 * A port of `tools/_seed_mock_runs.py` into the service, because seeding used to
 * require a Python interpreter and an ingest token — neither of which exists on
 * the cloud host where the demo actually gets shown. Every run written here
 * carries the MOCK marker, so the dashboard badges it and `clearSampleRuns()`
 * can take it all back out without touching a real analysis.
 *
 * Nothing in this file talks to the plant. The numbers are fiction.
 */
import ExcelJS from "exceljs";

import { saveIngestedRun, type IngestRun, type ReshimSummary } from "./reshim.js";
import { sendMail, type SendResult } from "./mail.js";

const FAMILIES = ["425", "430", "440", "450"] as const;

const VARIANTS: Record<string, string[]> = {
  "425": ["425-A-RH", "425-A-LH", "425-B-RH"],
  "430": ["430-B-LH", "430-C-RH"],
  "440": ["440-C-RH", "440-D-LH"],
  "450": ["450-E-RH"],
};

/* Per-variant baseline BAD rate. Uniform randomness makes every family look
 * alike and leaves the "variants flagged" panel permanently empty, which
 * demonstrates nothing — the point of the report is that trouble concentrates.
 * 440-D-LH is the persistent offender; 430-C-RH drifts and recovers. */
const BAD_RATE: Record<string, number> = {
  "425-A-RH": 0.07, "425-A-LH": 0.08, "425-B-RH": 0.11,
  "430-B-LH": 0.09, "430-C-RH": 0.14,
  "440-C-RH": 0.12, "440-D-LH": 0.34,
  "450-E-RH": 0.06,
};

/** Share of failures that are BAD_HEAVY rather than BAD. */
const HEAVY_SHARE = 0.28;

const SPEC_LABEL = "0.13–0.23";

/** Deterministic PRNG so re-seeding reproduces the same history instead of
 *  reshuffling it under a demo that someone already screenshotted. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SampleRow {
  sn: string;
  family: string;
  variant: string;
  measured: number;
  result: string;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10);
}

/**
 * One day of counts. `drift` lifts every variant's BAD rate together, so the
 * sparkline shows a deterioration that recovers rather than pure noise.
 */
function buildDay(
  dateStr: string,
  drift: number,
  rnd: () => number,
): { summary: ReshimSummary; rows: SampleRow[] } {
  const byFamily: Record<string, Record<string, number>> = {};
  const byVariant: Record<string, Record<string, number>> = {};
  const rows: SampleRow[] = [];
  let ok = 0, bad = 0, heavy = 0;

  const tally = (bucket: Record<string, Record<string, number>>, key: string, result: string) => {
    bucket[key] ??= {};
    bucket[key][result] = (bucket[key][result] ?? 0) + 1;
  };

  for (const fam of FAMILIES) {
    // ~120 units/day across the four families, which is the order of magnitude
    // the line actually runs, and enough that each variant clears the n>=8
    // minimum the flagging rule needs.
    const n = 22 + Math.floor(rnd() * 17);
    for (let i = 0; i < n; i++) {
      const pool = VARIANTS[fam];
      const variant = pool[Math.floor(rnd() * pool.length)];
      const rate = Math.min(0.9, BAD_RATE[variant] + drift);

      let result: string;
      let measured: number;
      if (rnd() >= rate) {
        result = "OK";
        measured = round(0.14 + rnd() * 0.08, 3);
        ok++;
      } else if (rnd() < HEAVY_SHARE) {
        result = "BAD_HEAVY";
        measured = round(0.33 + rnd() * 0.12, 3);
        heavy++;
      } else {
        result = "BAD";
        measured = round(0.24 + rnd() * 0.06, 3);
        bad++;
      }

      tally(byFamily, fam, result);
      tally(byVariant, variant, result);
      if (rows.length < 40) {
        const stamp = dateStr.slice(5).replace("-", "");
        rows.push({
          sn: `SAMPLE-${stamp}-${String(rows.length).padStart(4, "0")}`,
          family: fam,
          variant,
          measured,
          result,
        });
      }
    }
  }

  const high: ReshimSummary["high_bad_variants"] = [];
  for (const [variant, counts] of Object.entries(byVariant)) {
    const n = Object.values(counts).reduce((a, b) => a + b, 0);
    const b = (counts.BAD ?? 0) + (counts.BAD_HEAVY ?? 0);
    if (n >= 8 && (100 * b) / n >= 30) {
      high.push({ variant, n, bad_pct: round((100 * b) / n, 1) });
    }
  }
  high.sort((x, y) => y.bad_pct - x.bad_pct);

  const excluded = 2 + Math.floor(rnd() * 6);
  return {
    rows,
    summary: {
      total: ok + bad + heavy + excluded,
      excluded,
      ok,
      bad,
      bad_heavy: heavy,
      unknown_family: Math.floor(rnd() * 3),
      by_family: byFamily,
      by_variant: byVariant,
      high_bad_variants: high.slice(0, 5),
    },
  };
}

/* ── Workbook ─────────────────────────────────────────────────────────── */

async function workbook(dateStr: string, rows: SampleRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("SAMPLE - not real data");

  ws.mergeCells("A1:F1");
  const banner = ws.getCell("A1");
  banner.value = `SAMPLE DATA FOR ${dateStr} — INVENTED FIGURES, NOT MEASUREMENTS`;
  banner.font = { bold: true, size: 13, color: { argb: "FFC00000" } };
  ws.addRow([]);

  const header = ws.addRow(["Serial number", "Family", "Variant", "Backlash (mm)", "Spec", "Result"]);
  header.font = { bold: true };

  for (const r of rows) {
    ws.addRow([r.sn, r.family, r.variant, r.measured, SPEC_LABEL, r.result]);
  }
  [18, 10, 14, 15, 12, 12].forEach((w, i) => (ws.getColumn(i + 1).width = w));

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ── Seed / clear ─────────────────────────────────────────────────────── */

export interface SeedResult {
  days: number;
  dates: string[];
  email: SendResult | null;
}

/**
 * Write `days` of sample runs ending today. Returns the dates written, newest
 * last, plus the send result when `email` was asked for.
 */
export async function seedSampleRuns(days: number, opts: { email?: boolean } = {}): Promise<SeedResult> {
  const rnd = mulberry32(425);
  const dates: string[] = [];
  let newest: { dateStr: string; summary: ReshimSummary; report: IngestRun["report"] } | null = null;

  for (let i = days - 1; i >= 0; i--) {
    const dateStr = isoDay(i);
    // A bulge of trouble around three weeks back that settles down again, so the
    // 30-day sparkline has a story in it instead of a flat band.
    const drift = 0.16 * Math.max(0, 1 - Math.abs(i - 20) / 7);
    const { summary, rows } = buildDay(dateStr, drift, rnd);
    const report = {
      name: `SAMPLE-reshim-${dateStr}.xlsx`,
      base64: (await workbook(dateStr, rows)).toString("base64"),
    };

    saveIngestedRun({ dateStr, summary, email: null, report, mock: true });
    dates.push(dateStr);
    newest = { dateStr, summary, report };
  }

  let email: SendResult | null = null;
  if (opts.email && newest) {
    email = await sendSampleReport(newest.dateStr, newest.summary, newest.report!);
    // Record it on the run so the dashboard's Emailed column reflects reality
    // rather than a hardcoded "sent" the way the old Python seeder did.
    saveIngestedRun({
      dateStr: newest.dateStr,
      summary: newest.summary,
      email: { status: email.status, recipients: email.recipients, subject: email.subject },
      report: newest.report,
      mock: true,
    });
  }

  return { days, dates, email };
}

/* ── Sample report email ──────────────────────────────────────────────── */

function summaryTable(s: ReshimSummary): string {
  const incl = s.ok + s.bad + s.bad_heavy;
  const pct = (n: number) => (incl > 0 ? ((100 * n) / incl).toFixed(1) : "—");
  const cell = "padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px";
  const row = (k: string, v: string) =>
    `<tr><td style="${cell};color:#6b7280">${k}</td><td style="${cell};text-align:right;font-variant-numeric:tabular-nums">${v}</td></tr>`;

  const flagged = s.high_bad_variants.length
    ? s.high_bad_variants.map((v) => `${v.variant} (${v.bad_pct.toFixed(0)}% of ${v.n})`).join("<br>")
    : "none ≥30% BAD";

  return (
    `<table style="border-collapse:collapse;min-width:340px;margin:16px 0">` +
    row("Units analysed", String(incl)) +
    row("Excluded", String(s.excluded)) +
    row("OK", `${s.ok} &nbsp;(${pct(s.ok)}%)`) +
    row("BAD", `${s.bad} &nbsp;(${pct(s.bad)}%)`) +
    row("BAD_HEAVY", `${s.bad_heavy} &nbsp;(${pct(s.bad_heavy)}%)`) +
    row("Variants flagged", flagged) +
    `</table>`
  );
}

/**
 * The daily report's layout, over invented numbers, with the fact that it is a
 * sample stated in the subject and again in the first line of the body — the
 * recipients are the real distribution list, so it has to be unmistakable
 * without opening the attachment.
 */
export async function sendSampleReport(
  dateStr: string,
  summary: ReshimSummary,
  report: { name: string; base64: string },
): Promise<SendResult> {
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;line-height:1.5">` +
    `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px 14px;margin-bottom:18px">` +
    `<strong style="color:#b91c1c">SAMPLE — not real production data.</strong><br>` +
    `<span style="color:#7f1d1d;font-size:13px">Every figure below is invented. It was generated to verify that ` +
    `the automated report reaches you correctly, with the layout and attachment a real run would have. ` +
    `No action is needed and nothing on the line has been assessed.</span>` +
    `</div>` +
    `<p style="margin:0 0 4px">Reshim analysis — <strong>${dateStr}</strong></p>` +
    `<p style="margin:0;color:#6b7280;font-size:13px">Station 130/135 (SHIMMING 1/2) · family-specific backlash spec · ` +
    `operator photos linked via OCR of the SN label.</p>` +
    summaryTable(summary) +
    `<p style="color:#6b7280;font-size:12.5px;margin:0">The attached workbook carries the same sample rows, ` +
    `banner-marked on the first line of the sheet.</p>` +
    `<p style="color:#9ca3af;font-size:12px;margin:22px 0 0">— Daedalus reshim agent</p>` +
    `</div>`;

  return sendMail({
    subject: `[SAMPLE] Comer Fargo Reshim — ${dateStr}`,
    html,
    attachments: [{ name: report.name, contentBytes: report.base64 }],
  });
}
