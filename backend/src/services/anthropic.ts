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
  await new Promise((r) => setTimeout(r, 280 + Math.random() * 320));
  const q = user.toLowerCase();
  if (q.includes("torque")) {
    return "Torque pinion nut to 210–240 Nm in a 3-pass opposing-corner sequence (Comer QE-PG-04). [[advice:09]]";
  }
  if (q.includes("shim")) {
    return "Match shim SKU to the traveler exactly. Do not substitute. [[advice:07]]";
  }
  if (q.includes("orient") || q.includes("chamfer")) {
    return "Chamfered edge of the guide bearing cone faces inboard. [[instr:03]]";
  }
  if (q.includes("press")) {
    return "Press at 8–12 kN with a 2s ramp + 1s hold. Verify gauge ≤ 0.005mm. [[step:04]] [[step:05]]";
  }
  return "STUB: Answer grounded in retrieved nodes. Wire ANTHROPIC_API_KEY to enable real LLM responses.";
}
