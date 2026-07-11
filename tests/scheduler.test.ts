import { describe, expect, it, mock } from "bun:test";
import type { Database } from "../src/db";
import type { SandboxManager } from "../src/sandbox";
import { Scheduler, selectEligibleWorkerJobs } from "../src/scheduler";
import type { Config, Conversation, Job } from "../src/types";

const config = {
	copilotGithubToken: "secret",
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

function processWorker(
	scheduler: Scheduler,
	workerJob: Job,
	conversation: Conversation,
): Promise<void> {
	return (
		scheduler as unknown as {
			processWorker(job: Job, conversation: Conversation, recovered: boolean): Promise<void>;
		}
	).processWorker(workerJob, conversation, false);
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

	it("destroys a worker only after its changes are pushed", async () => {
		const finish = mock(async () => undefined);
		const destroy = mock(async () => undefined);
		const db = {
			getInstructions: mock(async () => null),
			setJobExecution: mock(async () => undefined),
			setJobExecSession: mock(async () => undefined),
			finishWorkerAndEnqueueResult: finish,
		} as unknown as Database;
		const sandbox = {
			createWorker: mock(async () => "sbx-worker"),
			runRunner: mock(async () => ({
				version: 1,
				ok: true,
				output: "Fixed it.",
				sessionId: "session",
				delegations: [],
				error: null,
				recreatedSession: false,
				delivery: {
					status: "pushed",
					branch: "feature/fix",
					commit: "abc123",
					error: null,
				},
			})),
			destroy,
		} as unknown as SandboxManager;
		const scheduler = new Scheduler(db, sandbox, { send: async () => undefined }, config);

		await processWorker(scheduler, job("job-pushed", "owner/repo", 1, "running"), {
			id: "conv",
		} as Conversation);

		expect(finish).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "done",
				result: expect.stringContaining("feature/fix"),
			}),
		);
		expect(destroy).toHaveBeenCalledWith("sbx-worker");
	});

	it("checkpoints a failed push before destroying the worker", async () => {
		const requeue = mock(async () => undefined);
		const destroy = mock(async () => undefined);
		const db = {
			getInstructions: mock(async () => null),
			setJobExecution: mock(async () => undefined),
			setJobExecSession: mock(async () => undefined),
			requeueWorkerDelivery: requeue,
			finishWorkerAndEnqueueResult: mock(async () => undefined),
		} as unknown as Database;
		const sandbox = {
			createWorker: mock(async () => "sbx-worker"),
			runRunner: mock(async () => ({
				version: 1,
				ok: true,
				output: "Fixed it.",
				sessionId: "session",
				delegations: [],
				error: null,
				recreatedSession: false,
				delivery: {
					status: "failed",
					branch: null,
					commit: null,
					error: "push rejected",
				},
			})),
			checkpoint: mock(async () => "worker-job-failed"),
			destroy,
		} as unknown as SandboxManager;
		const scheduler = new Scheduler(db, sandbox, { send: async () => undefined }, config);

		await processWorker(scheduler, job("job-failed", "owner/repo", 1, "running"), {
			id: "conv",
		} as Conversation);

		expect(requeue).toHaveBeenCalledWith(
			expect.objectContaining({
				checkpointName: "worker-job-failed",
				workerOutput: "Fixed it.",
			}),
		);
		expect(destroy).toHaveBeenCalledWith("sbx-worker");
	});

	it("keeps the live sandbox when checkpointing fails", async () => {
		const finish = mock(async () => undefined);
		const destroy = mock(async () => undefined);
		const db = {
			getInstructions: mock(async () => null),
			setJobExecution: mock(async () => undefined),
			setJobExecSession: mock(async () => undefined),
			finishWorkerAndEnqueueResult: finish,
		} as unknown as Database;
		const sandbox = {
			createWorker: mock(async () => "sbx-worker"),
			runRunner: mock(async () => ({
				version: 1,
				ok: true,
				output: "Fixed it.",
				sessionId: "session",
				delegations: [],
				error: null,
				recreatedSession: false,
				delivery: {
					status: "failed",
					branch: null,
					commit: null,
					error: "push rejected",
				},
			})),
			checkpoint: mock(async () => {
				throw new Error("checkpoint unavailable");
			}),
			destroy,
		} as unknown as SandboxManager;
		const scheduler = new Scheduler(db, sandbox, { send: async () => undefined }, config);

		await processWorker(scheduler, job("job-unsaved", "owner/repo", 1, "running"), {
			id: "conv",
		} as Conversation);

		expect(finish).toHaveBeenCalledWith(
			expect.objectContaining({ status: "failed", error: "checkpoint unavailable" }),
		);
		expect(destroy).not.toHaveBeenCalled();
	});

	it("destroys a worker when execution fails before checkpointing", async () => {
		const finish = mock(async () => undefined);
		const destroy = mock(async () => undefined);
		const db = {
			getInstructions: mock(async () => null),
			setJobExecution: mock(async () => undefined),
			setJobExecSession: mock(async () => undefined),
			finishWorkerAndEnqueueResult: finish,
		} as unknown as Database;
		const sandbox = {
			createWorker: mock(async () => "sbx-worker"),
			runRunner: mock(async () => {
				throw new Error("runner failed");
			}),
			destroy,
		} as unknown as SandboxManager;
		const scheduler = new Scheduler(db, sandbox, { send: async () => undefined }, config);

		await processWorker(scheduler, job("job-runner-failed", "owner/repo", 1, "running"), {
			id: "conv",
		} as Conversation);

		expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
		expect(destroy).toHaveBeenCalledWith("sbx-worker");
	});

	it("keeps successful delivery when checkpoint cleanup fails", async () => {
		const finish = mock(async () => undefined);
		const db = {
			getInstructions: mock(async () => null),
			setJobExecution: mock(async () => undefined),
			setJobExecSession: mock(async () => undefined),
			finishWorkerAndEnqueueResult: finish,
		} as unknown as Database;
		const sandbox = {
			restoreWorker: mock(async () => "sbx-restored"),
			runRunner: mock(async () => ({
				version: 1,
				ok: true,
				output: "",
				sessionId: null,
				delegations: [],
				error: null,
				recreatedSession: false,
				delivery: {
					status: "pushed",
					branch: "feature/fix",
					commit: "abc123",
					error: null,
				},
			})),
			deleteCheckpoint: mock(async () => {
				throw new Error("cleanup unavailable");
			}),
			destroy: mock(async () => undefined),
		} as unknown as SandboxManager;
		const scheduler = new Scheduler(db, sandbox, { send: async () => undefined }, config);
		const retry = job("job-cleanup", "owner/repo", 1, "running");
		retry.metadata = {
			deliveryOnly: true,
			checkpointName: "worker-job-cleanup",
			workerOutput: "Fixed it.",
			workerBranch: "glasses/job-cleanup",
		};

		await processWorker(scheduler, retry, { id: "conv" } as Conversation);

		expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "done" }));
	});

	it("restores a checkpoint and retries delivery without rerunning the worker task", async () => {
		const finish = mock(async () => undefined);
		const runRunner = mock(async (_sandboxId, input) => ({
			version: 1 as const,
			ok: true,
			output: "",
			sessionId: null,
			delegations: [],
			error: null,
			recreatedSession: false,
			delivery: {
				status: "pushed" as const,
				branch: "feature/fix",
				commit: "abc123",
				error: null,
			},
			input,
		}));
		const db = {
			getInstructions: mock(async () => null),
			setJobExecution: mock(async () => undefined),
			setJobExecSession: mock(async () => undefined),
			finishWorkerAndEnqueueResult: finish,
		} as unknown as Database;
		const sandbox = {
			restoreWorker: mock(async () => "sbx-restored"),
			runRunner,
			deleteCheckpoint: mock(async () => undefined),
			destroy: mock(async () => undefined),
		} as unknown as SandboxManager;
		const scheduler = new Scheduler(db, sandbox, { send: async () => undefined }, config);
		const retry = job("job-retry", "owner/repo", 1, "running");
		retry.metadata = {
			deliveryOnly: true,
			checkpointName: "worker-job-retry",
			workerOutput: "Fixed it.",
			workerBranch: "glasses/job-retry",
		};

		await processWorker(scheduler, retry, { id: "conv" } as Conversation);

		expect(runRunner.mock.calls[0]?.[1]).toEqual(
			expect.objectContaining({ deliveryOnly: true, workerBranch: "glasses/job-retry" }),
		);
		expect(finish).toHaveBeenCalledWith(
			expect.objectContaining({ status: "done", result: expect.stringContaining("Fixed it.") }),
		);
	});
});
