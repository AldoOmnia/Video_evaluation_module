/**
 * Read rows and embedded operator photos back out of a reshim workbook.
 *
 * The photos only exist inside the xlsx — the pipeline downscales them and
 * anchors them to their serial number's row, and nothing else keeps a copy. So
 * to show them on the dashboard they have to be read back out of the report.
 *
 * The three archived runs are three generations of the report and differ in
 * every detail that matters here, so this reads defensively rather than
 * assuming the current writer's output:
 *
 *   2026-08-19  inline strings, <oneCellAnchor>, rels Target="/xl/media/..."
 *   2026-09-17  shared strings, <xdr:twoCellAnchor>, Target="../media/..."
 *   2026-09-18  inline strings, <twoCellAnchor>, rels attributes reordered
 *
 * Hence: namespace prefixes are stripped before matching, both anchor kinds are
 * accepted, rel targets are normalised, and columns are located by header name
 * instead of by position (the oldest layout has 23 columns, not 21). Sample
 * workbooks put a banner in row 1 and titles such as `Serial number` later;
 * the header is the first row that names a serial-number column. A workbook
 * this cannot make sense of reports zero photos *and* says why, so the dashboard
 * can tell "no photos taken" apart from "cannot read this report".
 */
import JSZip from "jszip";

/** True when `source` is an already-opened archive, not the raw xlsx bytes. */
function isOpenZip(source: Buffer | JSZip): source is JSZip {
  return typeof (source as JSZip).files === "object" && typeof (source as JSZip).file === "function";
}

/** A photo anchored to a serial number's row. */
export interface SheetPhoto {
  /** Zip entry, e.g. `xl/media/image12.jpeg`. */
  entry: string;
  /** `tag` is the SN label shot used for OCR; the rest are process photos. */
  kind: "tag" | "process";
  /** Order within the row, left to right. */
  seq: number;
}

export interface SheetRow {
  sn: string;
  partNumber: string;
  family: string;
  status: string;
  backlash: number | null;
  photos: SheetPhoto[];
  /**
   * Photos the pipeline *matched* to this serial number, from the report's own
   * Image_Count. The sheet has a fixed number of image columns, so a serial
   * number with more matches than columns embeds only the first few — one run
   * matched 51 photos to a single SN and carries 7. Null when the column is
   * absent; equal to `photos.length` in the ordinary case.
   */
  matched: number | null;
}

export interface WorkbookRead {
  rows: SheetRow[];
  /** Non-null when the workbook could not be interpreted. */
  problem: string | null;
}

/* ── XML helpers ──────────────────────────────────────────────────────── */

/** Drop namespace prefixes so `<xdr:row>` and `<row>` match one pattern. */
function stripNs(xml: string): string {
  return xml.replace(/<(\/?)[A-Za-z][\w.-]*:/g, "<$1");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/** Column letters to a 0-based index: A→0, Z→25, AA→26. */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const ROW_RE = /<row r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL_RE = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

/** Shared strings, indexed as cells with `t="s"` reference them. */
function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  // Concatenate the runs inside each <si>: rich text splits one string across
  // several <t> elements, and taking only the first would truncate it.
  for (const si of stripNs(xml).matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let s = "";
    for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += t[1];
    out.push(unescapeXml(s));
  }
  return out;
}

/** One sheet row as a map of column letter to text. */
function readCells(body: string, shared: string[]): Map<string, string> {
  const cells = new Map<string, string>();
  for (const c of body.matchAll(CELL_RE)) {
    const [, col, attrs, inner] = c;
    if (inner == null) continue;              // self-closing: empty cell
    const type = /t="([^"]+)"/.exec(attrs)?.[1];
    if (type === "s") {
      const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]);
      cells.set(col, shared[idx] ?? "");
      continue;
    }
    const m = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner) ?? /<v>([\s\S]*?)<\/v>/.exec(inner);
    if (m) cells.set(col, unescapeXml(m[1]));
  }
  return cells;
}

/* ── Package navigation ───────────────────────────────────────────────── */

/** Resolve a relationship target against the part that declared it. */
function resolveTarget(target: string, baseDir: string): string {
  if (target.startsWith("/")) return target.slice(1);          // "/xl/media/x"
  const parts = (baseDir + "/" + target).split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "." || p === "") continue;
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack.join("/");
}

/** Relationship id to resolved zip entry, tolerating any attribute order. */
function relationships(xml: string, baseDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of xml.matchAll(/<Relationship\b([^>]*)>/g)) {
    const attrs = r[1];
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) out.set(id, resolveTarget(unescapeXml(target), baseDir));
  }
  return out;
}

/** The data sheet: the workbook's first sheet in declared order. */
async function firstSheetPath(zip: JSZip): Promise<string | null> {
  const wb = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!wb || !rels) return null;
  const relMap = relationships(rels, "xl");
  // Document order is sheet order; sheetId and rId are not reliable proxies.
  const first = /<sheet\b[^>]*>/.exec(stripNs(wb))?.[0];
  const rid = first ? /r:id="([^"]+)"|\bid="([^"]+)"/.exec(first) : null;
  const target = rid ? relMap.get(rid[1] ?? rid[2] ?? "") : null;
  return target ?? "xl/worksheets/sheet1.xml";
}

/* ── Photo anchors ────────────────────────────────────────────────────── */

interface Anchor { row: number; col: number; entry: string }

/**
 * Photo anchors as (0-based row, 0-based column, media entry).
 * Both anchor kinds carry the `<from>` marker this needs; `oneCellAnchor` just
 * sizes itself with `<ext>` instead of naming a second cell.
 */
async function readAnchors(zip: JSZip, sheetPath: string): Promise<Anchor[]> {
  const sheetDir = sheetPath.slice(0, sheetPath.lastIndexOf("/"));
  const sheetRelsPath = `${sheetDir}/_rels/${sheetPath.slice(sheetPath.lastIndexOf("/") + 1)}.rels`;
  const sheetRels = await zip.file(sheetRelsPath)?.async("string");
  if (!sheetRels) return [];

  const drawingPath = [...relationships(sheetRels, sheetDir).values()]
    .find((t) => /drawings\/drawing\d+\.xml$/.test(t));
  if (!drawingPath) return [];

  const drawingXml = await zip.file(drawingPath)?.async("string");
  if (!drawingXml) return [];
  const drawingDir = drawingPath.slice(0, drawingPath.lastIndexOf("/"));
  const drawingRels = await zip
    .file(`${drawingDir}/_rels/${drawingPath.slice(drawingPath.lastIndexOf("/") + 1)}.rels`)
    ?.async("string");
  const media = drawingRels ? relationships(drawingRels, drawingDir) : new Map();

  const xml = stripNs(drawingXml);
  const out: Anchor[] = [];
  for (const a of xml.matchAll(/<(oneCellAnchor|twoCellAnchor)\b[\s\S]*?<\/\1>/g)) {
    const block = a[0];
    const from = /<from>([\s\S]*?)<\/from>/.exec(block)?.[1];
    const embed = /<blip\b[^>]*r:embed="([^"]+)"|<blip\b[^>]*embed="([^"]+)"/.exec(block);
    if (!from || !embed) continue;
    const row = Number(/<row>(\d+)<\/row>/.exec(from)?.[1]);
    const col = Number(/<col>(\d+)<\/col>/.exec(from)?.[1]);
    const entry = media.get(embed[1] ?? embed[2] ?? "");
    if (entry && Number.isFinite(row) && Number.isFinite(col)) out.push({ row, col, entry });
  }
  return out;
}

/* ── Public read ──────────────────────────────────────────────────────── */

/** Header names this needs, in the order the pipeline has ever written them. */
const HEADER_ALIASES: Record<keyof Omit<SheetRow, "photos" | "matched">, string[]> = {
  sn: ["Serial_Number", "SN", "Serial Number", "Serial number"],
  partNumber: ["Internal_Part_Number", "Customer_Part_Number", "Part_Number"],
  family: ["Family"],
  status: ["Backlash_Status", "Status", "Result"],
  backlash: ["Backlash_avg_mm", "Backlash_Avg_mm", "Backlash_mm", "Backlash (mm)"],
};

export async function readWorkbook(source: Buffer | JSZip): Promise<WorkbookRead> {
  let zip: JSZip;
  try {
    zip = isOpenZip(source) ? source : await JSZip.loadAsync(source);
  } catch (e) {
    return { rows: [], problem: `not a readable xlsx (${(e as Error).message})` };
  }

  const sheetPath = await firstSheetPath(zip);
  const sheetXml = sheetPath ? await zip.file(sheetPath)?.async("string") : null;
  if (!sheetPath || !sheetXml) return { rows: [], problem: "no data sheet in the workbook" };

  const shared = sharedStrings(
    (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? null,
  );

  // Rows keyed by sheet row number, so anchors can be matched to them directly.
  const rowCells = new Map<number, Map<string, string>>();
  for (const r of stripNs(sheetXml).matchAll(ROW_RE)) {
    if (r[2] == null) continue;
    rowCells.set(Number(r[1]), readCells(r[2], shared));
  }
  if (rowCells.size < 2) return { rows: [], problem: "the data sheet has no rows" };

  const headerKey = (s: string) => s.trim().toLowerCase();
  const snHeaders = new Set(HEADER_ALIASES.sn.map(headerKey));

  // Header row: the first row that names a serial-number column. Archived
  // reports put that in row 1; sample workbooks put a banner there.
  let headerRowNum: number | null = null;
  let header: Map<string, string> | undefined;
  for (const [rowNum, cells] of [...rowCells].sort((a, b) => a[0] - b[0])) {
    for (const text of cells.values()) {
      if (snHeaders.has(headerKey(text))) {
        headerRowNum = rowNum;
        header = cells;
        break;
      }
    }
    if (header) break;
  }
  if (!header || headerRowNum == null) {
    const first = rowCells.get(Math.min(...rowCells.keys()))!;
    const found = [...first.values()].map((t) => t.trim()).filter(Boolean).slice(0, 6);
    return {
      rows: [],
      problem: `no Serial_Number column (found: ${found.join(", ") || "no headers"})`,
    };
  }

  const byName = new Map<string, string>();
  for (const [col, text] of header) byName.set(headerKey(text), col);

  const col = (field: keyof typeof HEADER_ALIASES): string | null => {
    for (const name of HEADER_ALIASES[field]) {
      const c = byName.get(headerKey(name));
      if (c) return c;
    }
    return null;
  };
  const snCol = col("sn");
  if (!snCol) {
    return {
      rows: [],
      problem: `no Serial_Number column (found: ${[...header.values()].map((t) => t.trim()).filter(Boolean).slice(0, 6).join(", ") || "no headers"})`,
    };
  }

  // Image columns, so a photo's column can be read as tag vs process. Falls
  // back to "leftmost anchored column is the tag shot", which is how every
  // generation has laid them out.
  const tagCol = byName.get(headerKey("Tag_Image")) ?? null;
  const tagIdx = tagCol ? colIndex(tagCol) : null;

  const anchors = await readAnchors(zip, sheetPath);
  const byRow = new Map<number, Anchor[]>();
  for (const a of anchors) {
    const sheetRow = a.row + 1;                 // anchors are 0-based
    const list = byRow.get(sheetRow);
    if (list) list.push(a);
    else byRow.set(sheetRow, [a]);
  }
  const minAnchorCol = anchors.length ? Math.min(...anchors.map((a) => a.col)) : null;
  const tagAt = tagIdx ?? minAnchorCol;

  const rows: SheetRow[] = [];
  for (const [rowNum, cells] of [...rowCells].sort((a, b) => a[0] - b[0])) {
    if (rowNum <= headerRowNum) continue;
    const sn = (cells.get(snCol) ?? "").trim();
    if (!sn) continue;

    const photos = (byRow.get(rowNum) ?? [])
      .sort((a, b) => a.col - b.col)
      .map((a, i) => ({
        entry: a.entry,
        kind: (tagAt != null && a.col === tagAt ? "tag" : "process") as SheetPhoto["kind"],
        seq: i,
      }));

    const matchedCol = byName.get(headerKey("Image_Count"));
    const matchedRaw = matchedCol ? cells.get(matchedCol) : undefined;
    const matched = matchedRaw == null || matchedRaw === "" ? null : Number(matchedRaw);

    const backlashRaw = cells.get(col("backlash") ?? "") ?? "";
    const backlash = backlashRaw === "" ? null : Number(backlashRaw);
    rows.push({
      sn,
      partNumber: (cells.get(col("partNumber") ?? "") ?? "").trim(),
      family: (cells.get(col("family") ?? "") ?? "").trim(),
      status: (cells.get(col("status") ?? "") ?? "").trim(),
      backlash: Number.isFinite(backlash) ? backlash : null,
      matched: matched != null && Number.isFinite(matched) ? matched : null,
      photos,
    });
  }

  return { rows, problem: null };
}

/** Read one media entry's bytes. Accepts an already-open archive so a gallery
 *  does not re-parse the whole xlsx for every thumbnail. */
export async function readMedia(source: Buffer | JSZip, entry: string): Promise<Buffer | null> {
  const zip = isOpenZip(source) ? source : await JSZip.loadAsync(source);
  const f = zip.file(entry);
  return f ? Buffer.from(await f.async("nodebuffer")) : null;
}
