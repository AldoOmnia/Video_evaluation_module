/**
 * Verify the workbook reader against every archived run.
 *
 * Run after touching reshim-xlsx.ts:  npx tsx tools/check-reshim-workbooks.mts
 *
 * The archive holds three generations of the report, which differ in string
 * storage, anchor element and relationship form, so these three files are the
 * reader's test corpus -- a change that works on the newest report can easily
 * break the oldest.
 *
 * The invariant that tests the reader: every photo anchor in the workbook is
 * attributed to a serial number -- nothing dropped, nothing counted twice. The
 * comparison is against anchors, not media files: 2026-09-17 anchors one image
 * to two rows (683 anchors, 682 images), and both serial numbers should show it,
 * so deduplicating by media entry would lose a photo that belongs on the page.
 *
 * Image_Count is reported alongside but not asserted on. It counts photos the
 * pipeline *matched*, which is an upper bound on what the sheet embeds: there are
 * a fixed number of image columns, and the oldest run also embeds fewer than it
 * matched on 23 rows. Only `found <= min(matched, columns)` is required.
 *
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { globSync } from "node:fs";

import { readWorkbook, readMedia } from "../backend/src/services/reshim-xlsx.js";

// Image_Count is read out again here, deliberately by a different route than the
// reader uses, to keep the check independent.
import JSZip from "jszip";

async function declaredCounts(buf: Buffer): Promise<Map<string, number>> {
  const zip = await JSZip.loadAsync(buf);
  const out = new Map<string, number>();
  for (const name of Object.keys(zip.files)) {
    if (!/xl\/worksheets\/sheet\d+\.xml$/.test(name)) continue;
    const xml = (await zip.file(name)!.async("string")).replace(/<(\/?)[A-Za-z][\w.-]*:/g, "<$1");
    const shared: string[] = [];
    const ssXml = await zip.file("xl/sharedStrings.xml")?.async("string");
    if (ssXml) {
      for (const si of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
        let s = "";
        for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
        shared.push(s);
      }
    }
    const rows: Array<Map<string, string>> = [];
    for (const r of xml.matchAll(/<row r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      if (r[2] == null) continue;
      const cells = new Map<string, string>();
      for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (c[3] == null) continue;
        const type = /t="([^"]+)"/.exec(c[2])?.[1];
        if (type === "s") {
          cells.set(c[1], shared[Number(/<v>([\s\S]*?)<\/v>/.exec(c[3])?.[1])] ?? "");
        } else {
          const m = /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[3]) ?? /<v>([\s\S]*?)<\/v>/.exec(c[3]);
          if (m) cells.set(c[1], m[1]);
        }
      }
      rows.push(cells);
    }
    if (rows.length === 0) continue;
    const header = rows[0];
    let snCol = "", cntCol = "";
    for (const [col, v] of header) {
      if (v.trim() === "Serial_Number") snCol = col;
      if (v.trim() === "Image_Count") cntCol = col;
    }
    if (!snCol || !cntCol) continue;
    for (const cells of rows.slice(1)) {
      const sn = (cells.get(snCol) ?? "").trim();
      if (sn) out.set(sn, Number(cells.get(cntCol) ?? 0) || 0);
    }
    if (out.size) break;
  }
  return out;
}

const files = globSync("shared/data/reshim-archive/*/*.xlsx").sort();
let failures = 0;

for (const f of files) {
  const date = f.split("/")[3];
  const buf = readFileSync(f);
  const { rows, problem } = await readWorkbook(buf);

  if (problem) {
    console.log(`FAIL ${date}: ${problem}`);
    failures++;
    continue;
  }

  const withPhotos = rows.filter((r) => r.photos.length > 0).length;
  const total = rows.reduce((n, r) => n + r.photos.length, 0);
  const tags = rows.reduce((n, r) => n + r.photos.filter((p) => p.kind === "tag").length, 0);

  const declared = await declaredCounts(buf);
  // The per-row ceiling: the widest row shows how many image columns exist.
  const columns = Math.max(0, ...rows.map((r) => r.photos.length));
  let overBound = 0, short = 0, capped = 0;
  const examples: string[] = [];
  for (const r of rows) {
    const d = declared.get(r.sn) ?? r.photos.length;
    const bound = Math.min(d, columns);
    if (d > columns) capped++;
    if (r.photos.length > bound) {
      overBound++;
      if (examples.length < 3) {
        examples.push(`${r.sn} matched ${d}, bound ${bound}, found ${r.photos.length}`);
      }
    } else if (r.photos.length < bound) short++;
  }

  // Every anchor must land on a serial number.
  const zip2 = await JSZip.loadAsync(buf);
  const mediaEntries = Object.keys(zip2.files).filter((n) => /\/media\//.test(n)).length;
  const drawingName = Object.keys(zip2.files).find((n) => /drawings\/drawing\d+\.xml$/.test(n));
  const drawingXml = drawingName
    ? (await zip2.file(drawingName)!.async("string")).replace(/<(\/?)[A-Za-z][\w.-]*:/g, "<$1")
    : "";
  const anchorCount = (drawingXml.match(/<(?:one|two)CellAnchor\b/g) ?? []).length;
  const distinctUsed = new Set(rows.flatMap((r) => r.photos.map((p) => p.entry))).size;
  const allMapped = total === anchorCount;

  // The bytes must actually be extractable, not merely referenced.
  const first = rows.find((r) => r.photos.length)?.photos[0];
  const bytes = first ? (await readMedia(buf, first.entry))?.length ?? 0 : 0;
  const jpeg = first ? (await readMedia(buf, first.entry))?.subarray(0, 2).toString("hex") : "";

  const ok = allMapped && overBound === 0 && (total === 0 || bytes > 0);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${date}  ${basename(f).slice(0, 34).padEnd(34)} ` +
    `rows=${String(rows.length).padStart(4)} photos=${String(total).padStart(4)} ` +
    `SNsWithPhotos=${String(withPhotos).padStart(4)} tags=${String(tags).padStart(4)} ` +
    `cols=${columns} mapped=${total}/${anchorCount}anch media=${distinctUsed}/${mediaEntries} overBound=${overBound} ` +
    `shortOfMatched=${short} cappedRows=${capped} ` +
    `firstImg=${bytes}B${jpeg === "ffd8" ? " jpeg" : jpeg ? ` magic:${jpeg}` : ""}`,
  );
  if (examples.length) console.log(`       e.g. ${examples.join("; ")}`);
}

console.log(failures === 0 ? "\nall workbooks read cleanly" : `\n${failures} workbook(s) failed`);
process.exit(failures === 0 ? 0 : 1);
