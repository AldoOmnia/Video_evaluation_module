/**
 * Anthropic wrapper. Falls back to a deterministic stub when no API key
 * is set or FORCE_STUB=1. The stub returns plausibly-shaped responses so
 * the rest of the pipeline can be exercised end-to-end.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config, stubMode } from "../config.js";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicKey });
  return client;
}

export interface LLMCallParams {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
}

export interface LLMResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  stubbed: boolean;
}

export async function llmCall(p: LLMCallParams): Promise<LLMResult> {
  const start = Date.now();
  if (stubMode) {
    const fake = await stubResponse(p);
    return {
      text: fake,
      inputTokens: Math.ceil((p.system.length + p.user.length) / 4),
      outputTokens: Math.ceil(fake.length / 4),
      latencyMs: Date.now() - start,
      stubbed: true,
    };
  }
  const res = await getClient().messages.create({
    model: p.model ?? config.anthropicModel,
    max_tokens: p.maxTokens ?? 400,
    system: p.system,
    messages: [{ role: "user", content: p.user }],
  });
  const text =
    res.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n")
      .trim() || "(no response)";
  return {
    text,
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
    latencyMs: Date.now() - start,
    stubbed: false,
  };
}

async function stubResponse({ user }: LLMCallParams): Promise<string> {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
  const q = user.toLowerCase();
  if (q.includes("torque")) {
    return JSON.stringify({
      glassesMessage: {
        label: "TORQUE",
        value: "210-240 Nm",
        action: "3-pass opposing",
        source: "S09 · [[step:09]]",
      },
      labBrief: {
        headline:
          "Pinion nut torque is 210–240 Nm in a 3-pass opposing-corner sequence.",
        bullets: ["Use calibrated click wrench. [[step:09]]"],
      },
      isAction: false,
    });
  }
  if (q.includes("shim")) {
    return JSON.stringify({
      glassesMessage: {
        label: "SHIM",
        value: "Match traveler",
        action: "No substitute",
        source: "[[advice:07]]",
      },
      labBrief: {
        headline: "Match shim SKU to the traveler exactly — do not substitute.",
        bullets: ["Wrong shim stack changes bearing preload. [[advice:07]]"],
      },
      isAction: false,
    });
  }
  if (q.includes("orient") || q.includes("chamfer")) {
    return JSON.stringify({
      glassesMessage: {
        label: "ORIENTATION",
        value: "Chamfer INBOARD",
        action: "Flip if outboard",
        source: "[[instr:03]]",
      },
      labBrief: {
        headline: "Chamfered edge of the guide bearing cone faces inboard.",
        bullets: [],
      },
      isAction: false,
    });
  }
  if (q.includes("press")) {
    return JSON.stringify({
      glassesMessage: {
        label: "PRESS DEPTH",
        value: "Gauge ≤0.005mm",
        action: "8-12 kN · 2s ramp",
        source: "S04-S05",
      },
      labBrief: {
        headline: "Press at 8–12 kN; verify depth gauge ≤ 0.005 mm before release.",
        bullets: ["[[step:04]] [[step:05]]"],
      },
      isAction: false,
    });
  }
  return JSON.stringify({
    glassesMessage: {
      label: "STUB MODE",
      value: "No API key",
      action: "Set ANTHROPIC_KEY",
      source: "Backend .env",
    },
    labBrief: {
      headline:
        "STUB: Wire ANTHROPIC_API_KEY on the server for live Claude responses.",
      bullets: [],
    },
    isAction: false,
  });
}
