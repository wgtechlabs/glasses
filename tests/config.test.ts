import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/config";

const validEnv = {
	RAILWAY_API_TOKEN: "rw_token",
	RAILWAY_ENVIRONMENT_ID: "env_123",
	DATABASE_URL: "postgresql://localhost/glasses",
	TELEGRAM_BOT_TOKEN: "bot_token",
	TELEGRAM_ALLOWED_USER_ID: "123456789",
	COPILOT_GITHUB_TOKEN: "copilot_token",
};

describe("loadConfig", () => {
	it("loads orchestration defaults", () => {
		const config = loadConfig(validEnv as NodeJS.ProcessEnv);
		expect(config.mainSandboxIdleMinutes).toBe(60);
		expect(config.memoryMessageLimit).toBe(20);
		expect(config.schedulerWorkerConcurrency).toBe(4);
		expect(config.copilotGithubToken).toBe("copilot_token");
	});

	it("accepts bounded orchestration overrides", () => {
		const config = loadConfig({
			...validEnv,
			MAIN_SANDBOX_IDLE_MINUTES: "15",
			MEMORY_MESSAGE_LIMIT: "8",
			SCHEDULER_WORKER_CONCURRENCY: "2",
		} as NodeJS.ProcessEnv);
		expect(config.mainSandboxIdleMinutes).toBe(15);
		expect(config.memoryMessageLimit).toBe(8);
		expect(config.schedulerWorkerConcurrency).toBe(2);
	});

	it("requires sandbox Copilot authentication", () => {
		const { COPILOT_GITHUB_TOKEN, ...incomplete } = validEnv;
		expect(() => loadConfig(incomplete as NodeJS.ProcessEnv)).toThrow(/copilotGithubToken/);
	});
});
