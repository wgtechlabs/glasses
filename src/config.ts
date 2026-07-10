import { z } from "zod";
import type { Config } from "./types";

const configSchema = z.object({
  railwayApiToken: z.string().min(1, "RAILWAY_API_TOKEN is required"),
  railwayEnvironmentId: z
    .string()
    .min(1, "RAILWAY_ENVIRONMENT_ID is required"),
  databaseUrl: z.string().min(1, "DATABASE_URL is required"),
  telegramBotToken: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  telegramAllowedUserId: z
    .string()
    .min(1, "TELEGRAM_ALLOWED_USER_ID is required"),
  port: z.number().int().positive().default(3000),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

/**
 * Loads and validates configuration from environment variables.
 * Throws with a descriptive message if any required variable is missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw = {
    railwayApiToken: env.RAILWAY_API_TOKEN,
    railwayEnvironmentId: env.RAILWAY_ENVIRONMENT_ID,
    databaseUrl: env.DATABASE_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserId: env.TELEGRAM_ALLOWED_USER_ID,
    port: env.PORT ? Number.parseInt(env.PORT, 10) : 3000,
    logLevel: env.LOG_LEVEL || "info",
  };

  const result = configSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }

  return result.data;
}
