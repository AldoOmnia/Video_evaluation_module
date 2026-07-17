/**
 * Gemini vision wrapper — mirrors the glasses build's vlmObserve architecture
 * (comer-rokid-demo backend/routes/vlmObserve.js) so platform testing is 1:1:
 *
 *   - primary model  : gemini-3.5-flash  (same as the glasses VLM observe loop)
 *   - fallback model : gemini-2.5-flash  (same demo-resilience fallback — the
 *     3.5 fleet still throws transient 5xx; retrying the SAME model on the
 *     same flake rarely helps, hopping models does)
 *   - env overrides  : GEMINI_VLM_OBSERVE_MODEL / GEMINI_VLM_FALLBACK_MODEL /
 *     GEMINI_API_KEY — identical names to the glasses backend so one .env
 *     can be shared across both.
 *
 * Calls go over the REST generateContent endpoint (no SDK dependency).
 * When no GEMINI_API_KEY is set the caller gets { stubbed: true } and must
 * degrade gracefully — same contract as the Anthropic wrapper.
 */

const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const KEY = (process.env.GEMINI_API_KEY ?? "").trim();
export const VISION_MODEL =
  (process.env.GEMINI_VLM_OBSERVE_MODEL ?? "").trim() || "gemini-3.5-flash";
export const VISION_FALLBACK_MODEL =
  (process.env.GEMINI_VLM_FALLBACK_MODEL ?? "").trim() || "gemini-2.5-flash";

export function geminiConfigured(): boolean {
  return KEY.length > 0;
}

export interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

export interface GeminiResult {
  text: string;
  model: string;
  latencyMs: number;
  stubbed: boolean;
}

async function generateContent(
  model: string,
  parts: GeminiPart[],
  timeoutMs: number,
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/${model}:generateContent?key=${KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 900,
          // Skip the reasoning pass — same latency lever the glasses use to
          // keep the observe round-trip under ~2s with ~1MB of references.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`gemini ${model} HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("\n")
      .trim();
    if (!text) throw new Error(`gemini ${model}: empty response`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Vision call with the glasses' primary→fallback hop. Throws only when both
 * models fail (or the single model fails and fallback is identical/disabled).
 */
export async function geminiVisionCall(parts: GeminiPart[]): Promise<GeminiResult> {
  const start = Date.now();
  if (!geminiConfigured()) {
    return {
      text: "",
      model: "stub",
      latencyMs: Date.now() - start,
      stubbed: true,
    };
  }
  try {
    const text = await generateContent(VISION_MODEL, parts, 25_000);
    return { text, model: VISION_MODEL, latencyMs: Date.now() - start, stubbed: false };
  } catch (primaryErr) {
    if (VISION_FALLBACK_MODEL === VISION_MODEL || VISION_FALLBACK_MODEL.toLowerCase() === "none") {
      throw primaryErr;
    }
    const text = await generateContent(VISION_FALLBACK_MODEL, parts, 20_000);
    return {
      text,
      model: VISION_FALLBACK_MODEL,
      latencyMs: Date.now() - start,
      stubbed: false,
    };
  }
}
