/**
 * /api/worldlabs/* — thin proxy in front of the World Labs (Marble) World API.
 *
 * Exists so the API key stays server-side (backend/.env). The synthetic-pov
 * splat panel calls these endpoints; it never sees the key.
 */
import { Router } from "express";
import { z } from "zod";

import { config } from "../config.js";
import {
  generateWorld,
  getWorld,
  pollOperation,
  resolveSplatUrl,
  worldLabsConfigured,
} from "../services/worldlabs.js";

export const worldLabsRouter = Router();

worldLabsRouter.get("/status", (_req, res) => {
  res.json({ configured: worldLabsConfigured(), model: config.worldLabsModel });
});

const GenerateSchema = z.object({
  prompt: z.string().max(2000).optional(),
  model: z.string().max(64).optional(),
  imageUrl: z.string().url().optional(),
  localAsset: z.string().max(128).optional(),
  isPano: z.boolean().optional(),
  multiImageAssets: z.array(z.string().max(128)).max(8).optional(),
  reconstruct: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  displayName: z.string().max(120).optional(),
});

worldLabsRouter.post("/generate", async (req, res, next) => {
  try {
    if (!worldLabsConfigured()) {
      return res
        .status(503)
        .json({ error: "World Labs is not configured on the server" });
    }
    const body = GenerateSchema.parse(req.body ?? {});
    const out = await generateWorld(body);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

worldLabsRouter.get("/operation/:id", async (req, res, next) => {
  try {
    if (!worldLabsConfigured()) {
      return res
        .status(503)
        .json({ error: "World Labs is not configured on the server" });
    }
    const status = await pollOperation(req.params.id);
    res.json(status);
  } catch (e) {
    next(e);
  }
});

/** Status of a world by id (resume a generation we only have the world_id for). */
worldLabsRouter.get("/world/:id", async (req, res, next) => {
  try {
    if (!worldLabsConfigured()) {
      return res
        .status(503)
        .json({ error: "World Labs is not configured on the server" });
    }
    const status = await getWorld(req.params.id);
    res.json(status);
  } catch (e) {
    next(e);
  }
});

/**
 * Stream the world's Gaussian splat (.spz) bytes through our origin so the
 * browser (Spark) can fetch it without CORS issues, and so the short-lived
 * signed asset URL never reaches the client.
 */
worldLabsRouter.get("/world/:id/splat", async (req, res, next) => {
  try {
    if (!worldLabsConfigured()) {
      return res
        .status(503)
        .json({ error: "World Labs is not configured on the server" });
    }
    const quality =
      typeof req.query.quality === "string" ? req.query.quality : undefined;
    const url = await resolveSplatUrl(req.params.id, quality);
    if (!url) {
      return res.status(404).json({ error: "Splat asset not ready" });
    }
    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) {
      return res
        .status(502)
        .json({ error: `Upstream splat fetch failed (${upstream.status})` });
    }
    res.setHeader(
      "Content-Type",
      upstream.headers.get("content-type") || "application/octet-stream",
    );
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("Content-Length", len);
    res.setHeader("Cache-Control", "public, max-age=3600");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (e) {
    next(e);
  }
});
