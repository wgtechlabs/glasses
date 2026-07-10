import { describe, expect, it, mock } from "bun:test";
import type { Database } from "../src/db";
import type { SandboxManager } from "../src/sandbox";
import { Scheduler, selectEligibleWorkerJobs } from "../src/scheduler";
import type { Config, Conversation, Job } from "../src/types";

const config = {
	copilotGithubToken: "secret",
	mainSandboxIdleMinutes: 30,
	schedulerPollMs: 2000,
	schedulerWorkerConcurrency: 4,
	jobTimeoutSeconds: 3600,
	memoryMessageLimit: 20,
	memoryWorkerLimit: 10,
} as Config;

function job(id: string, repository: string, createdAt: number, status: Job["status"]): Job {
	return {
		id,
		conversationId: "conv",
		kind: "worker",
		prompt: "task",
		repository,
		status,
		result: null,
		error: null,
		sandboxId: null,
		execSessionName: null,
		parentJobId: null,
		claimedAt: null,
		metadata: {},
		createdAt: new Date(createdAt),
		updatedAt: new Date(createdAt),
	};
}

describe("scheduler eligibility", () => {
	it("queues same-repository work while allowing a different repository", () => {
		const pending = [
			job("same-1", "owner/one", 1, "pending"),
			job("same-2", "owner/one", 2, "pending"),
			job("other", "owner/two", 3, "pending"),
		];
		expect(selectEligibleWorkerJobs(pending, [])).toEqual([pending[0], pending[2]]);
		expect(selectEligibleWorkerJobs(pending, [job("running", "owner/one", 0, "running")])).toEqual([
			pending[2],
		]);
	});

	it("recreates a stale main sandbox and clears the old SDK session", async () => {
		const update = mock(async () => undefined);
		const db = { updateConversationRuntime: update } as unknown as Database;
		const sandbox = {
			isAlive: mock(async () => false),
			createMain: mock(async () => "sbx-new"),
		} as unknown as SandboxManager;
		const scheduler = new Scheduler(db, sandbox, { send: async () => undefined }, config);
		const conversation = {
			id: "conv",
			channel: "telegram",
			userId: "123",
			chatId: "456",
			sandboxId: "sbx-stale",
			copilotSessionId: "old-session",
		} as Conversation;
		const runtime = await scheduler.ensureMainSandbox(conversation);
		expect(runtime).toEqual({ sandboxId: "sbx-new", recreated: true, sessionId: null });
		expect(update).toHaveBeenCalledWith("conv", "sbx-new", null);
	});
});
