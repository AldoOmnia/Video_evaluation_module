/**
 * STEP export for the camera-support generator.
 *
 * The solid is built by OpenCascade (through replicad) in a worker thread —
 * see backend/workers/fixture-step.mjs for what the file contains and why it
 * runs off the main thread. This module owns the worker's lifecycle: one
 * export at a time, a hard timeout, and a clear reason when the kernel is not
 * installed.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { totalmem } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { REPO_ROOT } from "../paths.js";

const WORKER = join(REPO_ROOT, "backend", "workers", "fixture-step.mjs");
/** Generous: a two-anchor structure with ties takes about 35 s on a laptop. */
const TIMEOUT_MS = 240_000;

export interface StepReport {
  members: number;
  lofted: number;
  segmented: number;
  fuseFailures: number;
  cutFailures: number;
  holes: number;
  solids: number;
  volumeMm3: number;
  ms: number;
}

export interface StepCapability {
  available: boolean;
  reason: string;
}

/**
 * Memory the host must have for a STEP build. Measured on this code: the
 * kernel peaks 400–480 MB above the server's own ~130 MB (one anchor → two
 * anchors with ties). The worker shares the server's process, so running out
 * does not fail the export — it kills the server. Below this, refuse.
 */
const STEP_MIN_HOST_MB = 900;

/** The memory this process may use: the container's limit if there is one. */
function hostMemoryMb(): number {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const bytes = Number(readFileSync(path, "utf8").trim());
      // "max", or the kernel's "no limit" sentinel, means the machine's memory.
      if (Number.isFinite(bytes) && bytes > 0 && bytes < totalmem()) return bytes / 1048576;
    } catch {
      /* not a cgroup host */
    }
  }
  return totalmem() / 1048576;
}

/** Whether this host can write STEP, and if not, why — shown in the UI. */
export function stepCapability(): StepCapability {
  if (!existsSync(WORKER)) {
    return { available: false, reason: "the STEP worker is missing from this deployment" };
  }
  // FIXTURE_STEP=on overrides the memory check (for a host whose limit cannot
  // be read); FIXTURE_STEP=off turns the export off.
  const override = (process.env.FIXTURE_STEP ?? "").toLowerCase();
  if (override === "off") {
    return { available: false, reason: "STEP export is turned off on this host (FIXTURE_STEP=off)" };
  }
  const mb = hostMemoryMb();
  if (override !== "on" && mb < STEP_MIN_HOST_MB) {
    return {
      available: false,
      reason: `the CAD kernel needs about 500 MB while it builds and this host has ${Math.round(mb)} MB — export OBJ here, or run the platform on a machine with 1 GB or more for STEP`,
    };
  }
  try {
    const require = createRequire(WORKER);
    require.resolve("replicad");
    require.resolve("replicad-opencascadejs/wasm");
  } catch {
    return {
      available: false,
      reason: "the CAD kernel is not installed on this host — run npm install in the repo",
    };
  }
  return { available: true, reason: "" };
}

let busy = false;

export class StepBusyError extends Error {}

export function buildStep(solid: unknown): Promise<{ bytes: Uint8Array; report: StepReport }> {
  if (busy) {
    return Promise.reject(new StepBusyError("another STEP export is still being built — try again in a minute"));
  }
  busy = true;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: { solid } });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      busy = false;
      fn();
    };
    const timer = setTimeout(() => {
      void worker.terminate();
      finish(() => reject(new Error("the CAD kernel did not finish in time — simplify the structure (fewer feet or ties) and try again")));
    }, TIMEOUT_MS);
    worker.once("message", (msg: { ok: boolean; bytes?: Uint8Array; report?: Omit<StepReport, "ms">; error?: string }) => {
      void worker.terminate();
      if (msg.ok && msg.bytes && msg.report) {
        const report = { ...msg.report, ms: Date.now() - started };
        finish(() => resolve({ bytes: msg.bytes as Uint8Array, report }));
      } else {
        finish(() => reject(new Error(msg.error ?? "the CAD kernel failed")));
      }
    });
    worker.once("error", (err) => finish(() => reject(err)));
    worker.once("exit", (code) => {
      finish(() => reject(new Error(`the CAD kernel stopped unexpectedly (exit ${code})`)));
    });
  });
}
