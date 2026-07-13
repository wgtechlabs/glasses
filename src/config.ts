import { z } from "zod";
import type { Config } from "./types";

const configSchema = z.object({
	railwayApiToken: z.string().min(1, "RAILWAY_API_TOKEN is required"),
	railwayEnvironmentId: z.string().min(1, "RAILWAY_ENVIRONMENT_ID is required"),
	databaseUrl: z.string().min(1, "DATABASE_URL is required"),
	telegramBotToken: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
	telegramAllowedUserId: z.string().min(1, "TELEGRAM_ALLOWED_USER_ID is required"),
	copilotGithubToken: z.string().min(1, "COPILOT_GITHUB_TOKEN or GH_TOKEN is required"),
	memoryMessageLimit: z.number().int().min(1).max(100).default(20),
	memoryWorkerLimit: z.number().int().min(0).max(50).default(10),
	schedulerPollMs: z.number().int().min(250).max(60_000).default(2000),
	schedulerWorkerConcurrency: z.number().int().min(1).max(20).default(4),
	jobTimeoutSeconds: z.number().int().min(60).max(86_400).default(3600),
	port: z.number().int().positive().default(3000),
	logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
	return env[name] ? Number.parseInt(env[name] as string, 10) : fallback;
}

/** Loads and validates gateway configuration without logging secret values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const result = configSchema.safeParse({
		railwayApiToken: env.RAILWAY_API_TOKEN,
		railwayEnvironmentId: env.RAILWAY_ENVIRONMENT_ID,
		databaseUrl: env.DATABASE_URL,
		telegramBotToken: env.TELEGRAM_BOT_TOKEN,
		telegramAllowedUserId: env.TELEGRAM_ALLOWED_USER_ID,
		copilotGithubToken: env.COPILOT_GITHUB_TOKEN ?? env.GH_TOKEN,
		memoryMessageLimit: integer(env, "MEMORY_MESSAGE_LIMIT", 20),
		memoryWorkerLimit: integer(env, "MEMORY_WORKER_LIMIT", 10),
		schedulerPollMs: integer(env, "SCHEDULER_POLL_MS", 2000),
		schedulerWorkerConcurrency: integer(env, "SCHEDULER_WORKER_CONCURRENCY", 4),
		jobTimeoutSeconds: integer(env, "JOB_TIMEOUT_SECONDS", 3600),
		port: integer(env, "PORT", 3000),
		logLevel: env.LOG_LEVEL || "info",
	});

	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid configuration: ${issues}`);
	}
	return result.data;
}
