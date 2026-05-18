import { Router } from "express";
import { specs } from "../services/specs.js";

export const specRouter = Router();

specRouter.get("/all", (_req, res) => res.json(specs));
specRouter.get("/procedure", (_req, res) => res.json(specs.procedure));
specRouter.get("/taxonomy", (_req, res) => res.json(specs.taxonomy));
specRouter.get("/hardware", (_req, res) => res.json(specs.hardware));
specRouter.get("/strategies", (_req, res) => res.json(specs.strategies));
