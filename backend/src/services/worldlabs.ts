/**
 * World Labs (Marble) World API client — server-side only.
 *
 * The API key lives in backend/.env (WORLDLABS_API_KEY) and is NEVER sent to
 * the browser. The synthetic-pov page talks to our /api/worldlabs/* proxy,
 * which forwards to https://api.worldlabs.ai with the key attached here.
 *
 * Flow: generate -> returns operation_id -> poll /operations/{id} until
 * done -> response.world_marble_url + assets.splats.spz_urls. Generation is
 * asynchronous (minutes) and consumes credits.
 *
 * Docs: https://docs.worldlabs.ai/api
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { config } from "../config.js";
import { EVAL_LAB_PUBLIC } from "../paths.js";

const BASE = "https://api.worldlabs.ai/marble/v1";

export function worldLabsConfigured(): boolean {
  return Boolean(config.worldLabsKey);
}

function headers(extra?: Record<string, string>) {
  return {
    "WLT-Api-Key": config.worldLabsKey,
    ...(extra ?? {}),
  };
}

async function wlFetch(path: string, init?: RequestInit): Promise<any> {
  if (!worldLabsConfigured()) {
    throw new Error("WORLDLABS_API_KEY is not configured on the server");
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const msg =
      (json && (json.detail || json.message || json.error)) ||
      text ||
      `World Labs request failed (${res.status})`;
    const err = new Error(
      typeof msg === "string" ? msg : JSON.stringify(msg),
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json;
}

export interface GenerateOptions {
  prompt?: string;
  model?: string;
  /** A publicly reachable image URL to ground the world on. */
  imageUrl?: string;
  /** Upload + ground on a local asset under eval-lab/public/assets/. */
  localAsset?: string;
  /** Make the world public so its Marble URL is embeddable. */
  isPublic?: boolean;
  displayName?: string;
}

/** Upload a local asset (e.g. worker_pov.jpg) and return its media_asset_id. */
async function uploadLocalAsset(fileName: string): Promise<string> {
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, "");
  const ext = (safe.split(".").pop() || "jpg").toLowerCase();
  const abs = join(EVAL_LAB_PUBLIC, "assets", safe);
  const bytes = await readFile(abs);

  const prep = await wlFetch("/media-assets:prepare_upload", {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ file_name: safe, kind: "image", extension: ext }),
  });

  const assetId: string =
    prep?.media_asset?.media_asset_id ?? prep?.media_asset?.id;
  const uploadUrl: string = prep?.upload_info?.upload_url;
  const required: Record<string, string> =
    prep?.upload_info?.required_headers ?? {};
  if (!assetId || !uploadUrl) {
    throw new Error("World Labs prepare_upload returned no upload target");
  }

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: required,
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`Asset upload failed (${put.status})`);
  }
  return assetId;
}

export async function generateWorld(opts: GenerateOptions): Promise<{
  operationId: string;
  worldId?: string;
}> {
  const model = opts.model || config.worldLabsModel;
  const isPublic = opts.isPublic ?? true;

  let world_prompt: Record<string, unknown>;
  if (opts.localAsset) {
    const mediaAssetId = await uploadLocalAsset(opts.localAsset);
    world_prompt = {
      type: "image",
      image_prompt: { source: "media_asset", media_asset_id: mediaAssetId },
      ...(opts.prompt ? { text_prompt: opts.prompt } : {}),
    };
  } else if (opts.imageUrl) {
    world_prompt = {
      type: "image",
      image_prompt: { source: "uri", uri: opts.imageUrl },
      ...(opts.prompt ? { text_prompt: opts.prompt } : {}),
    };
  } else {
    world_prompt = {
      type: "text",
      text_prompt:
        opts.prompt ||
        "Industrial assembly workstation on a manufacturing line: a workbench " +
          "with a gearbox pinion housing, torque wrench, shim trays, and parts " +
          "bins under bright overhead lighting, concrete floor, factory bay.",
    };
  }

  const body = {
    display_name: opts.displayName || "Comer · synthetic POV",
    model,
    world_prompt,
    permission: { public: isPublic },
  };

  const op = await wlFetch("/worlds:generate", {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });

  return {
    operationId: op?.operation_id,
    worldId: op?.metadata?.world_id,
  };
}

export interface OperationStatus {
  done: boolean;
  status: string;
  progress?: string;
  worldId?: string;
  marbleUrl?: string;
  thumbnail?: string;
  spz?: Record<string, string> | null;
  error?: string | null;
}

export async function pollOperation(id: string): Promise<OperationStatus> {
  const op = await wlFetch(`/operations/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: headers(),
  });

  const meta = op?.metadata ?? {};
  const prog = meta?.progress ?? {};
  const resp = op?.response ?? null;
  const worldId: string | undefined = resp?.id ?? meta?.world_id;

  return {
    done: Boolean(op?.done),
    status: prog?.status || (op?.done ? "SUCCEEDED" : "IN_PROGRESS"),
    progress: prog?.description,
    worldId,
    marbleUrl:
      resp?.world_marble_url ||
      (worldId ? `https://marble.worldlabs.ai/world/${worldId}` : undefined),
    thumbnail: resp?.assets?.thumbnail_url,
    spz: resp?.assets?.splats?.spz_urls ?? null,
    error:
      typeof op?.error === "string"
        ? op.error
        : op?.error
          ? JSON.stringify(op.error)
          : null,
  };
}

/**
 * Fetch a world by id. Used to "resume"/track a generation initiated earlier
 * (we only have the world_id, not the operation_id). The world's `assets`
 * field is null until generation finishes; once present it carries the
 * Gaussian splat (.spz) URLs we render in-page with Spark.
 */
export async function getWorld(id: string): Promise<OperationStatus & {
  displayName?: string;
}> {
  const w = await wlFetch(`/worlds/${encodeURIComponent(id)}`, {
    method: "GET",
    headers: headers(),
  });

  const assets = w?.assets ?? null;
  const spz: Record<string, string> | null = assets?.splats?.spz_urls ?? null;
  const ready = Boolean(spz && Object.keys(spz).length);

  return {
    done: ready,
    status: ready ? "SUCCEEDED" : "IN_PROGRESS",
    progress: assets?.caption ? undefined : "Generating world",
    worldId: w?.world_id ?? id,
    marbleUrl:
      w?.world_marble_url || `https://marble.worldlabs.ai/world/${id}`,
    thumbnail: assets?.thumbnail_url,
    spz,
    error: null,
    displayName: w?.display_name,
  };
}

/**
 * Resolve a web-friendly .spz URL for a world. Marble exports several LODs
 * (e.g. 100k / 150k / 500k / full_res); we prefer a mid-detail level that
 * balances fidelity and download size, with sensible fallbacks.
 */
export async function resolveSplatUrl(
  id: string,
  quality?: string,
): Promise<string | null> {
  const w = await getWorld(id);
  if (!w.spz) return null;
  const spz = w.spz;
  const prefer = [quality, "500k", "150k", "100k", "full_res"].filter(
    Boolean,
  ) as string[];
  for (const key of prefer) {
    if (spz[key]) return spz[key];
  }
  const urls = Object.values(spz);
  return urls.length ? urls[0] : null;
}
