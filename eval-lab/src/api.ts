/**
 * Thin browser client over the backend. Each method is a one-call function
 * matching the route. Errors are surfaced; never silently swallowed.
 */
import type { RunResult } from "../../shared/types/run.js";
import type { SessionEvent } from "../../shared/types/events.js";
import type { Taxonomy } from "../../shared/types/taxonomy.js";
import type { ProcedureSpec } from "../../shared/types/procedure.js";
import type { HardwareProfiles } from "../../shared/types/hardware.js";
import type { Strategies } from "../../shared/types/strategy.js";
import type { GraphNode } from "../../backend/src/services/retrieval.js";

export interface ApiClientOptions {
  baseUrl?: string;
}

export class ApiClient {
  constructor(private readonly opts: ApiClientOptions = {}) {}
  private url(p: string): string {
    return `${this.opts.baseUrl ?? ""}${p}`;
  }

  async loadAllSpecs(): Promise<{
    procedure: ProcedureSpec;
    taxonomy: Taxonomy;
    hardware: HardwareProfiles;
    strategies: Strategies;
  }> {
    const r = await fetch(this.url("/api/spec/all"));
    if (!r.ok) throw new Error(`spec load failed (${r.status})`);
    return r.json();
  }

  async chat(query: string): Promise<{
    answer: string;
    citations: string[];
    retrieved: GraphNode[];
    tokens: { input: number; output: number };
    latencyMs: number;
    stubbed: boolean;
  }> {
    const r = await fetch(this.url("/api/brain/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) throw new Error(`chat failed (${r.status})`);
    return r.json();
  }

  async runEval(args: {
    hardwareId: string;
    strategyId: string;
    events: SessionEvent[];
    liveLLM?: boolean;
  }): Promise<RunResult> {
    const r = await fetch(this.url("/api/eval"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!r.ok) throw new Error(`eval failed (${r.status})`);
    return r.json();
  }
}
