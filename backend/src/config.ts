import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT ?? "3001", 10),
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
  forceStub: process.env.FORCE_STUB === "1",
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  worldLabsKey: process.env.WORLDLABS_API_KEY ?? "",
  worldLabsModel: process.env.WORLDLABS_MODEL ?? "marble-1.1",
};

export const stubMode = config.forceStub || !config.anthropicKey;
