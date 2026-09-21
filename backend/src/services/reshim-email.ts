/**
 * The reshim report email, for real runs and for sample ones.
 *
 * One template with a `sample` flag rather than two: the recipients are the same
 * people, and a sample that does not look like the real thing tests nothing. The
 * only differences are the subject prefix and a banner, and both are conspicuous.
 *
 * The Python agent (`tools/reshim/email_report.py`) still sends the daily report
 * from wherever it runs. This exists so an already-produced run can be sent from
 * the platform — the cloud host has no Python, and a run kept in the archive has
 * no live pipeline behind it to re-trigger.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { sendMail, type SendResult } from "./mail.js";
import { listRuns, runReportPath, type ReshimSummary } from "./reshim.js";
import { runDetail } from "./reshim-detail.js";

const CONTEXT =
  "Station 130/135 (SHIMMING 1/2) · family-specific backlash spec · " +
  "operator photos linked via OCR of the SN label.";

const CELL = "padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px";
const NUM = `${CELL};text-align:right;font-variant-numeric:tabular-nums`;

function row(k: string, v: string): string {
  return `<tr><td style="${CELL};color:#6b7280">${k}</td><td style="${NUM}">${v}</td></tr>`;
}

function summaryTable(s: ReshimSummary): string {
  const incl = s.ok + s.bad + s.bad_heavy;
  const pct = (n: number) => (incl > 0 ? ((100 * n) / incl).toFixed(1) : "—");
  const flagged = s.high_bad_variants.length
    ? s.high_bad_variants.map((v) => `${v.variant} (${v.bad_pct.toFixed(0)}% of ${v.n})`).join("<br>")
    : "none at or above 30% BAD";

  return (
    `<table style="border-collapse:collapse;min-width:360px;margin:16px 0">` +
    row("Units analysed", String(incl)) +
    row("Excluded", String(s.excluded)) +
    row("OK", `${s.ok} &nbsp;(${pct(s.ok)}%)`) +
    row("BAD", `${s.bad} &nbsp;(${pct(s.bad)}%)`) +
    row("BAD_HEAVY", `${s.bad_heavy} &nbsp;(${pct(s.bad_heavy)}%)`) +
    row("Variants flagged", flagged) +
    `</table>`
  );
}

/** Per-family OK rate — the first thing asked after the headline number. */
function familyTable(s: ReshimSummary): string {
  const families = Object.entries(s.by_family).sort(([a], [b]) => a.localeCompare(b));
  if (families.length === 0) return "";

  const head = `<tr>${["Family", "n", "OK", "BAD", "BAD_HEAVY", "OK %"]
    .map((h, i) => `<th style="${i === 0 ? CELL : NUM};color:#6b7280;font-weight:600;text-align:${i === 0 ? "left" : "right"}">${h}</th>`)
    .join("")}</tr>`;

  const body = families
    .map(([fam, counts]) => {
      const n = Object.values(counts).reduce((a, b) => a + b, 0);
      const ok = counts.OK ?? 0;
      const pct = n > 0 ? ((100 * ok) / n).toFixed(1) : "—";
      return (
        `<tr><td style="${CELL}">${fam}</td>` +
        `<td style="${NUM}">${n}</td><td style="${NUM}">${ok}</td>` +
        `<td style="${NUM}">${counts.BAD ?? 0}</td><td style="${NUM}">${counts.BAD_HEAVY ?? 0}</td>` +
        `<td style="${NUM}">${pct}%</td></tr>`
      );
    })
    .join("");

  return (
    `<p style="margin:18px 0 0;font-size:13px;color:#6b7280">By family</p>` +
    `<table style="border-collapse:collapse;min-width:420px;margin:8px 0 0">${head}${body}</table>`
  );
}

export function buildReportSubject(dateStr: string, s: ReshimSummary, sample: boolean): string {
  const incl = s.ok + s.bad + s.bad_heavy;
  const pct = incl > 0 ? Math.round((100 * s.ok) / incl) : 0;
  // Mirrors the agent's own subject, so the two are filed together in a mailbox.
  const subject = `Comer Fargo Reshim — ${dateStr} (${incl} units, ${pct}% OK)`;
  return sample ? `[SAMPLE] ${subject}` : subject;
}

/**
 * Serials whose photo the pipeline could not link. The daily Python agent
 * already prints this in its plain-text body; the platform-side send mirrors
 * the same list so a report triggered from the dashboard tells recipients
 * the same story a cron run would.
 */
function missingPhotosSection(missing: string[]): string {
  if (missing.length === 0) return "";
  const shown = missing.slice(0, 20);
  const rest = missing.length - shown.length;
  const chips = shown
    .map(
      (sn) =>
        `<span style="display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:12px;` +
        `background:#fef3c7;color:#78350f;border:1px solid #fcd34d;border-radius:4px;` +
        `padding:2px 8px;margin:2px 4px 2px 0">${sn}</span>`,
    )
    .join("");
  const overflow =
    rest > 0
      ? `<span style="color:#6b7280;font-size:12px">&nbsp;… and ${rest} more (see attachment).</span>`
      : "";
  return (
    `<p style="margin:18px 0 6px;font-size:13px;color:#6b7280">` +
    `Missing photos — ${missing.length} unit${missing.length === 1 ? "" : "s"} to review manually` +
    `</p><div>${chips}${overflow}</div>`
  );
}

export function buildReportHtml(
  dateStr: string,
  s: ReshimSummary,
  opts: { sample: boolean; attachmentName?: string; missing?: string[] },
): string {
  const banner = opts.sample
    ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px 14px;margin-bottom:18px">` +
      `<strong style="color:#b91c1c">SAMPLE — not real production data.</strong><br>` +
      `<span style="color:#7f1d1d;font-size:13px">Every figure below is invented. It was generated to verify that ` +
      `the automated report reaches you correctly, with the layout and attachment a real run would have. ` +
      `No action is needed and nothing on the line has been assessed.</span></div>`
    : "";

  const attachment = opts.attachmentName
    ? `<p style="color:#6b7280;font-size:12.5px;margin:18px 0 0">Per-unit detail, including the ` +
      `operator photos, is in the attached workbook (${opts.attachmentName}).</p>`
    : "";

  return (
    `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;line-height:1.5">` +
    banner +
    `<p style="margin:0 0 4px">Reshim analysis — <strong>${dateStr}</strong></p>` +
    `<p style="margin:0;color:#6b7280;font-size:13px">${CONTEXT}</p>` +
    summaryTable(s) +
    familyTable(s) +
    missingPhotosSection(opts.missing ?? []) +
    attachment +
    `<p style="color:#9ca3af;font-size:12px;margin:22px 0 0">— Daedalus reshim agent. ` +
    `Reply to this email to reach Aldo.</p>` +
    `</div>`
  );
}

/* ── Send an already-produced run ─────────────────────────────────────── */

export interface SendRunOptions {
  /** Defaults to MAIL_RECIPIENTS. */
  to?: string[];
  /** Override the sample banner; defaults to whether the run is marked mock. */
  sample?: boolean;
}

/**
 * Email the report for a run that already exists on disk, from either root.
 * Reads the workbook at send time rather than taking it as an argument, so the
 * caller cannot pair one run's figures with another's attachment.
 */
export async function sendRunReport(dateStr: string, opts: SendRunOptions = {}): Promise<SendResult> {
  const run = listRuns(365).find((r) => r.date === dateStr);
  if (!run) throw new Error(`no run for ${dateStr}`);
  if (!run.summary) throw new Error(`run ${dateStr} has no summary to report`);

  const path = runReportPath(dateStr);
  const attachments = path
    ? [{ name: basename(path), contentBytes: readFileSync(path).toString("base64") }]
    : [];

  // Best-effort read of the workbook to enumerate serials without photos.
  // A parse failure or a missing report is not fatal — the summary is; the
  // missing-photos list is a courtesy signal so recipients don't have to open
  // the xlsx to notice.
  let missing: string[] = [];
  try {
    const detail = await runDetail(dateStr);
    missing = detail?.missing ?? [];
  } catch {
    // Fall through — recipients still get the report, just without the chip list.
  }

  const sample = opts.sample ?? run.mock;
  return sendMail({
    subject: buildReportSubject(dateStr, run.summary, sample),
    html: buildReportHtml(dateStr, run.summary, {
      sample,
      attachmentName: attachments[0]?.name,
      missing,
    }),
    to: opts.to,
    attachments,
  });
}
