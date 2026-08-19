import { createApp } from "./app.js";
import { createPostgresInfrastructure } from "./infrastructure.js";
import { OpenAIResponsesModelProvider } from "@ear/model-provider";

const authMode = process.env.AUTH_MODE ?? "demo";
const auth = authMode === "jwt"
  ? {
      mode: "jwt" as const,
      secret: requiredEnvironment("JWT_SECRET"),
      issuer: process.env.JWT_ISSUER ?? "enterprise-auth",
      audience: process.env.JWT_AUDIENCE ?? "enterprise-agent-runtime",
    }
  : { mode: "demo" as const };

const infrastructure = process.env.DATABASE_URL
  ? await createPostgresInfrastructure(process.env.DATABASE_URL)
  : undefined;
const modelProvider = process.env.OPENAI_API_KEY
  ? new OpenAIResponsesModelProvider({
      apiKey: process.env.OPENAI_API_KEY,
      model: requiredEnvironment("OPENAI_MODEL"),
      ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
    })
  : undefined;
const { app } = createApp({ auth, infrastructure, modelProvider });
const port = Number(process.env.PORT ?? 3001);

await app.listen({ host: "127.0.0.1", port });
console.log(`Enterprise Agent Runtime API: http://127.0.0.1:${port}`);

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
