/**
 * Per-run detail for the dashboard: the rows behind a run's summary, and the
 * operator photos that go with them.
 *
 * Both come out of the run's workbook, because that is the only place they
 * exist — summary.json holds counts, and the photos live nowhere but inside the
 * xlsx. Parsing a 20 MB workbook per thumbnail request would be absurd, so a
 * small LRU keeps the parsed manifest and the loaded archive for the runs being
 * looked at; a gallery then costs one cheap inflate per image.
 */
import { readFileSync, statSync } from "node:fs";

import JSZip from "jszip";

import { readMedia, readWorkbook, type SheetRow } from "./reshim-xlsx.js";
import { runReportPath } from "./reshim.js";

export interface DetailPhoto {
  /** Opaque, stable for a given run: `<row>-<seq>`. */
  id: string;
  kind: "tag" | "process";
}

export interface DetailItem {
  sn: string;
  partNumber: string;
  family: string;
  status: string;
  backlash: number | null;
  /** Photos the pipeline matched; may exceed `photos.length`. See SheetRow. */
  matched: number | null;
  photos: DetailPhoto[];
}

export interface RunDetail {
  date: string;
  /** Rows in the report, serial numbers only. */
  units: number;
  withPhotos: number;
  /** Null when there are no rows to divide by. */
  coverage: number | null;
  photoCount: number;
  /** Serial numbers carrying no photo, in sheet order. */
  missing: string[];
  items: DetailItem[];
  /**
   * Why the workbook could not be read, when it could not be. Kept distinct
   * from "no photos": a report from a format this cannot parse must not be
   * presented as a day when nobody took pictures.
   */
  problem: string | null;
  /**
   * Workbook identity: changes when the report is replaced, so photo URLs
   * that include it do not serve a previous run's bytes.
   */
  rev: string;
}

interface Entry {
  key: string;                      // path + mtime + size
  detail: RunDetail;
  /** Photo id to zip entry, for serving bytes without re-parsing the sheet. */
  entries: Map<string, string>;
  /** Already-open archive: a gallery then inflates one entry per image. */
  zip: JSZip;
}

/** Two runs is enough for looking at one and comparing with another. */
const MAX_CACHED = 2;
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry | null>>();

function stamp(path: string): { key: string; rev: string } {
  const s = statSync(path);
  return { key: `${path}:${s.mtimeMs}:${s.size}`, rev: `${s.mtimeMs}-${s.size}` };
}

function touch(date: string, entry: Entry): void {
  cache.delete(date);
  cache.set(date, entry);
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
}

function toDetail(date: string, rows: SheetRow[], problem: string | null, rev: string): {
  detail: RunDetail;
  entries: Map<string, string>;
} {
  const entries = new Map<string, string>();
  const items: DetailItem[] = [];
  const missing: string[] = [];
  let photoCount = 0;

  rows.forEach((r, rowIdx) => {
    const photos: DetailPhoto[] = r.photos.map((p, i) => {
      const id = `${rowIdx}-${i}`;
      entries.set(id, p.entry);
      return { id, kind: p.kind };
    });
    photoCount += photos.length;
    if (photos.length === 0) missing.push(r.sn);
    items.push({
      sn: r.sn,
      partNumber: r.partNumber,
      family: r.family,
      status: r.status,
      backlash: r.backlash,
      matched: r.matched,
      photos,
    });
  });

  const withPhotos = items.length - missing.length;
  return {
    detail: {
      date,
      units: items.length,
      withPhotos,
      coverage: items.length > 0 ? (100 * withPhotos) / items.length : null,
      photoCount,
      missing,
      items,
      problem,
      rev,
    },
    entries,
  };
}

async function build(date: string): Promise<Entry | null> {
  const path = runReportPath(date);
  if (!path) return null;

  const { key, rev } = stamp(path);
  const hit = cache.get(date);
  if (hit && hit.key === key) {
    touch(date, hit);
    return hit;
  }

  const workbook = readFileSync(path);
  // Open here so the cache can reuse the archive for photos. readWorkbook
  // only catches loadAsync when it is given raw bytes, so a corrupt file
  // must be turned into `problem` here — otherwise the gallery gets a 500.
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(workbook);
  } catch (e) {
    const { detail, entries } = toDetail(
      date,
      [],
      `not a readable xlsx (${(e as Error).message})`,
      rev,
    );
    const entry: Entry = { key, detail, entries, zip: new JSZip() };
    touch(date, entry);
    return entry;
  }
  const { rows, problem } = await readWorkbook(zip);
  const { detail, entries } = toDetail(date, rows, problem, rev);
  const entry: Entry = { key, detail, entries, zip };
  touch(date, entry);
  return entry;
}

/** Single-flight, so a gallery opening does not parse the workbook many times. */
function load(date: string): Promise<Entry | null> {
  const running = inflight.get(date);
  if (running) return running;
  const p = build(date).finally(() => inflight.delete(date));
  inflight.set(date, p);
  return p;
}

/** Null when the run has no report to read. */
export async function runDetail(date: string): Promise<RunDetail | null> {
  return (await load(date))?.detail ?? null;
}

export interface PhotoBytes {
  buf: Buffer;
  type: string;
}

const MIME: Record<string, string> = {
  jpeg: "image/jpeg", jpg: "image/jpeg", png: "image/png",
  gif: "image/gif", bmp: "image/bmp", webp: "image/webp",
};

export async function runPhoto(date: string, id: string): Promise<PhotoBytes | null> {
  const entry = await load(date);
  const zipPath = entry?.entries.get(id);
  if (!entry || !zipPath) return null;

  const buf = await readMedia(entry.zip, zipPath);
  if (!buf) return null;
  const ext = zipPath.slice(zipPath.lastIndexOf(".") + 1).toLowerCase();
  return { buf, type: MIME[ext] ?? "application/octet-stream" };
}
