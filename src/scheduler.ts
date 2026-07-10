import type { Database } from "./db";
import { logger } from "./logger";
import type { RunnerEvent, RunnerInput, RunnerResult } from "./runner-protocol";
import type { SandboxManager } from "./sandbox";
import type { Config, Conversation, Job } from "./types";

export interface ChatNotifier {
	send(chatId: string, text: string): Promise<void>;
}

export function selectEligibleWorkerJobs(pending: Job[], running: Job[]): Job[] {
	const active = new Set(
		running
			.filter((job) => job.kind === "worker" && job.repository)
			.map((job) => `${job.conversationId}:${job.repository}`),
	);
	const selected = new Set<string>();
	return [...pending]
		.filter((job) => job.kind === "worker" && job.repository)
		.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
		.filter((job) => {
			const key = `${job.conversationId}:${job.repository}`;
			if (active.has(key) || selected.has(key)) return false;
			selected.add(key);
			return true;
		});
}

export class Scheduler {
	private timer: NodeJS.Timeout | null = null;
	private ticking = false;
	private readonly active = new Set<string>();

	constructor(
		private db: Database,
		private sandbox: SandboxManager,
		private notifier: ChatNotifier,
		private config: Config,
	) {}

	async start(): Promise<void> {
		await this.recoverRunningJobs();
		this.timer = setInterval(() => this.kick(), this.config.schedulerPollMs);
		this.timer.unref();
		this.kick();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	kick(): void {
		if (this.ticking) return;
		this.ticking = true;
		void this.tick()
			.catch((error) => {
				logger.error("Scheduler claim cycle failed", {
					reason: error instanceof Error ? error.name : "unknown",
				});
			})
			.finally(() => {
				this.ticking = false;
			});
	}

	async invalidateMainSandbox(sandboxId: string | null): Promise<void> {
		if (sandboxId) await this.sandbox.destroy(sandboxId);
	}

	/** Ensures stale main sandboxes are replaced and their SDK session is not reused. */
	async ensureMainSandbox(
		conversation: Conversation,
	): Promise<{ sandboxId: string; recreated: boolean; sessionId: string | null }> {
		if (conversation.sandboxId && (await this.sandbox.isAlive(conversation.sandboxId))) {
			return {
				sandboxId: conversation.sandboxId,
				recreated: false,
				sessionId: conversation.copilotSessionId,
			};
		}
		const sandboxId = await this.sandbox.createMain(
			this.config.copilotGithubToken,
			this.config.mainSandboxIdleMinutes,
		);
		await this.db.updateConversationRuntime(conversation.id, sandboxId, null);
		return { sandboxId, recreated: true, sessionId: null };
	}

	private async tick(): Promise<void> {
		const capacity = this.config.schedulerWorkerConcurrency;
		while (this.active.size < capacity * 2) {
			const job = await this.db.claimMainJob();
			if (!job) break;
			this.launch(job, false);
		}
		let workers = [...this.active].filter((key) => key.startsWith("worker:")).length;
		while (workers < capacity) {
			const job = await this.db.claimWorkerJob();
			if (!job) break;
			this.launch(job, false);
			workers += 1;
		}
	}

	private launch(job: Job, recovered: boolean): void {
		const key = `${job.kind === "worker" ? "worker" : "main"}:${job.id}`;
		if (this.active.has(key)) return;
		this.active.add(key);
		void this.processJob(job, recovered)
			.catch((error) => {
				logger.error("Scheduler job processing failed", {
					jobId: job.id,
					kind: job.kind,
					reason: error instanceof Error ? error.name : "unknown",
				});
			})
			.finally(() => {
				this.active.delete(key);
				this.kick();
			});
	}

	private async processJob(job: Job, recovered: boolean): Promise<void> {
		const conversation = await this.db.getConversation(job.conversationId);
		if (!conversation) {
			await this.db.failJob(job.id, "Conversation no longer exists.");
			return;
		}
		if (job.kind === "worker") {
			await this.processWorker(job, conversation, recovered);
		} else {
			await this.processMain(job, conversation, recovered);
		}
	}

	private async processMain(
		job: Job,
		conversation: Conversation,
		recovered: boolean,
	): Promise<void> {
		try {
			await this.notifier.send(
				conversation.chatId,
				recovered ? "Reattaching to the running main session…" : "Starting the main session…",
			);
			let sandboxId: string;
			let result: RunnerResult;
			if (recovered) {
				if (!job.sandboxId || !job.execSessionName) {
					throw new Error("Running main job has no durable Railway exec session.");
				}
				sandboxId = job.sandboxId;
				result = await this.sandbox.reattachRunner(
					sandboxId,
					job.execSessionName,
					this.config.jobTimeoutSeconds,
					{ onEvent: (event) => this.mainEvent(conversation, event) },
				);
			} else {
				const runtime = await this.ensureMainSandbox(conversation);
				sandboxId = runtime.sandboxId;
				await this.db.setJobExecution(job.id, sandboxId);
				const input = await this.mainInput(job, conversation, runtime.recreated, runtime.sessionId);
				result = await this.sandbox.runRunner(sandboxId, input, this.config.jobTimeoutSeconds, {
					onExecSession: (name) => this.db.setJobExecSession(job.id, name),
					onEvent: (event) => this.mainEvent(conversation, event),
				});
			}
			if (!result.ok) throw new Error(result.error ?? "Main runner failed.");
			await this.db.completeMainJob({
				job,
				output: result.output,
				sessionId: result.sessionId,
				sandboxId,
				delegations: result.delegations,
			});
			await this.notifier.send(conversation.chatId, result.output);
			for (const delegation of result.delegations) {
				await this.notifier.send(
					conversation.chatId,
					`Queued worker for ${delegation.repository}.`,
				);
			}
		} catch (error) {
			const message = this.safeError(error);
			await this.db.failJob(job.id, message);
			await this.notifier.send(
				conversation.chatId,
				recovered
					? "The previously running main job could not be reattached and was marked failed."
					: "The main session failed. The failure was recorded; send another message to retry safely.",
			);
		}
	}

	private async processWorker(
		job: Job,
		conversation: Conversation,
		recovered: boolean,
	): Promise<void> {
		let sandboxId = job.sandboxId;
		try {
			if (!job.repository) throw new Error("Worker repository is missing.");
			await this.notifier.send(
				conversation.chatId,
				recovered
					? `Reattaching to the running worker for ${job.repository}…`
					: `Starting worker for ${job.repository}…`,
			);
			let result: RunnerResult;
			if (recovered) {
				if (!sandboxId || !job.execSessionName) {
					throw new Error("Running worker has no durable Railway exec session.");
				}
				result = await this.sandbox.reattachRunner(
					sandboxId,
					job.execSessionName,
					this.config.jobTimeoutSeconds,
					{ onEvent: this.workerEventReporter(conversation, job) },
				);
			} else {
				sandboxId = await this.sandbox.createWorker(this.config.copilotGithubToken);
				await this.db.setJobExecution(job.id, sandboxId);
				const input: RunnerInput = {
					version: 1,
					mode: "worker",
					prompt: job.prompt,
					globalInstructions:
						(await this.db.getInstructions(conversation.channel, conversation.userId)) ?? "",
					sessionId: null,
					rehydrate: false,
					transcript: [],
					workerSummaries: [],
					repository: job.repository,
				};
				result = await this.sandbox.runRunner(sandboxId, input, this.config.jobTimeoutSeconds, {
					onExecSession: (name) => this.db.setJobExecSession(job.id, name),
					onEvent: this.workerEventReporter(conversation, job),
				});
			}
			if (!result.ok) throw new Error(result.error ?? "Worker runner failed.");
			await this.db.finishWorkerAndEnqueueResult({
				job,
				status: "done",
				result: result.output,
				error: null,
			});
			await this.notifier.send(
				conversation.chatId,
				`Worker completed for ${job.repository}; preparing the main-session update.`,
			);
		} catch (error) {
			await this.db.finishWorkerAndEnqueueResult({
				job,
				status: "failed",
				result: null,
				error: this.safeError(error),
			});
			await this.notifier.send(
				conversation.chatId,
				`Worker failed for ${job.repository ?? "the repository"}; the main session will report it.`,
			);
		} finally {
			if (sandboxId) await this.sandbox.destroy(sandboxId);
		}
	}

	private async mainInput(
		job: Job,
		conversation: Conversation,
		rehydrate: boolean,
		sessionId: string | null,
	): Promise<RunnerInput> {
		const transcript = await this.db.getRecentTranscript(
			conversation.id,
			this.config.memoryMessageLimit,
		);
		if (transcript.at(-1)?.role === "user" && transcript.at(-1)?.content === job.prompt) {
			transcript.pop();
		}
		return {
			version: 1,
			mode: "main",
			prompt: job.prompt,
			globalInstructions:
				(await this.db.getInstructions(conversation.channel, conversation.userId)) ?? "",
			sessionId,
			rehydrate,
			transcript,
			workerSummaries: await this.db.getRecentWorkerSummaries(
				conversation.id,
				this.config.memoryWorkerLimit,
			),
		};
	}

	private async mainEvent(conversation: Conversation, event: RunnerEvent): Promise<void> {
		if (event.type === "lifecycle" && event.stage === "running") {
			await this.notifier.send(conversation.chatId, "Main session is running…");
		}
	}

	private workerEventReporter(
		conversation: Conversation,
		job: Job,
	): (event: RunnerEvent) => Promise<void> {
		const reportedTools = new Set<string>();
		return async (event) => {
			if (event.type === "lifecycle" && event.stage === "cloning") {
				await this.notifier.send(conversation.chatId, `Cloning ${job.repository}…`);
			} else if (event.type === "lifecycle" && event.stage === "running") {
				await this.notifier.send(conversation.chatId, `Worker is running for ${job.repository}…`);
			} else if (
				event.type === "tool" &&
				event.stage === "started" &&
				reportedTools.size < 8 &&
				!reportedTools.has(event.name)
			) {
				reportedTools.add(event.name);
				await this.notifier.send(conversation.chatId, `Worker tool: ${event.name}`);
			}
		};
	}

	private async recoverRunningJobs(): Promise<void> {
		for (const job of await this.db.getRunningJobs()) this.launch(job, true);
	}

	private safeError(error: unknown): string {
		const raw = error instanceof Error ? error.message : "Unknown orchestration error.";
		return raw.replaceAll(this.config.copilotGithubToken, "[REDACTED]").slice(0, 4000);
	}
}
