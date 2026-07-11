import type { Database } from "./db";
import { logger } from "./logger";
import type { RunnerInput, RunnerResult } from "./runner-protocol";
import type { SandboxManager } from "./sandbox";
import type { Config, Conversation, Job } from "./types";

export interface ChatNotifier {
	send(chatId: string, text: string): Promise<void>;
	startStreaming?(chatId: string): { update(delta: string): void; stop(): void };
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
		await this.db.requeueFailedWorkerDeliveries();
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
		const sandboxId = await this.sandbox.createMain(this.config.copilotGithubToken);
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
		const stream = this.notifier.startStreaming?.(conversation.chatId);
		try {
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
					{
						onEvent: (event) => {
							if (event.type === "text_delta") stream?.update(event.content);
						},
					},
				);
			} else {
				const runtime = await this.ensureMainSandbox(conversation);
				sandboxId = runtime.sandboxId;
				await this.db.setJobExecution(job.id, sandboxId);
				const input = await this.mainInput(job, conversation, runtime.recreated, runtime.sessionId);
				result = await this.sandbox.runRunner(sandboxId, input, this.config.jobTimeoutSeconds, {
					onExecSession: (name) => this.db.setJobExecSession(job.id, name),
					onEvent: (event) => {
						if (event.type === "text_delta") stream?.update(event.content);
					},
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
		} catch (error) {
			const message = this.safeError(error);
			await this.db.failJob(job.id, message);
			await this.notifier.send(
				conversation.chatId,
				recovered
					? "The previously running main job could not be reattached and was marked failed."
					: "The main session failed. The failure was recorded; send another message to retry safely.",
			);
		} finally {
			stream?.stop();
		}
	}

	private async processWorker(
		job: Job,
		conversation: Conversation,
		recovered: boolean,
	): Promise<void> {
		let sandboxId = job.sandboxId;
		let destroySandbox = true;
		const deliveryOnly = job.metadata.deliveryOnly === true;
		const checkpointName =
			typeof job.metadata.checkpointName === "string" ? job.metadata.checkpointName : null;
		const workerBranch =
			typeof job.metadata.workerBranch === "string"
				? job.metadata.workerBranch
				: `glasses/${job.id}`;
		try {
			if (!job.repository) throw new Error("Worker repository is missing.");
			let result: RunnerResult;
			if (recovered) {
				if (!sandboxId || !job.execSessionName) {
					throw new Error("Running worker has no durable Railway exec session.");
				}
				result = await this.sandbox.reattachRunner(
					sandboxId,
					job.execSessionName,
					this.config.jobTimeoutSeconds,
				);
			} else {
				if (deliveryOnly && !checkpointName) {
					throw new Error("Worker delivery retry has no checkpoint.");
				}
				sandboxId =
					deliveryOnly && checkpointName
						? await this.sandbox.restoreWorker(this.config.copilotGithubToken, checkpointName)
						: await this.sandbox.createWorker(this.config.copilotGithubToken);
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
					workerBranch,
					deliveryOnly,
				};
				result = await this.sandbox.runRunner(sandboxId, input, this.config.jobTimeoutSeconds, {
					onExecSession: (name) => this.db.setJobExecSession(job.id, name),
				});
			}
			if (!result.ok) throw new Error(result.error ?? "Worker runner failed.");
			if (!result.delivery || result.delivery.status === "failed") {
				const deliveryError = this.safeError(
					result.delivery?.error ?? "Legacy worker result requires delivery.",
				);
				if (deliveryOnly && checkpointName) {
					destroySandbox = true;
					const output =
						typeof job.metadata.workerOutput === "string"
							? job.metadata.workerOutput
							: "Worker changes were completed.";
					await this.db.finishWorkerAndEnqueueResult({
						job,
						status: "failed",
						result: `${output}\n\nDelivery is still pending. The changes remain saved in Railway checkpoint \`${checkpointName}\` and will retry after the gateway restarts.`,
						error: deliveryError,
					});
					return;
				}
				if (!sandboxId) throw new Error(deliveryError);
				destroySandbox = false;
				const savedCheckpoint = await this.sandbox.checkpoint(sandboxId, `worker-${job.id}`);
				await this.db.requeueWorkerDelivery({
					job,
					checkpointName: savedCheckpoint,
					workerOutput: result.output,
					workerBranch,
				});
				destroySandbox = true;
				return;
			}
			const output =
				deliveryOnly && typeof job.metadata.workerOutput === "string"
					? job.metadata.workerOutput
					: result.output;
			const deliveryNote =
				result.delivery.status === "pushed"
					? `\n\nChanges pushed to \`${result.delivery.branch}\` at \`${result.delivery.commit}\`.`
					: "";
			if (checkpointName) {
				try {
					await this.sandbox.deleteCheckpoint(checkpointName);
				} catch (error) {
					logger.warn("Delivered worker checkpoint cleanup failed", {
						jobId: job.id,
						reason: error instanceof Error ? error.name : "unknown",
					});
				}
			}
			await this.db.finishWorkerAndEnqueueResult({
				job,
				status: "done",
				result: `${output}${deliveryNote}`,
				error: null,
			});
			destroySandbox = true;
		} catch (error) {
			await this.db.finishWorkerAndEnqueueResult({
				job,
				status: "failed",
				result: null,
				error: this.safeError(error),
			});
		} finally {
			if (sandboxId && destroySandbox) await this.sandbox.destroy(sandboxId);
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

	private async recoverRunningJobs(): Promise<void> {
		for (const job of await this.db.getRunningJobs()) this.launch(job, true);
	}

	private safeError(error: unknown): string {
		const raw = error instanceof Error ? error.message : "Unknown orchestration error.";
		return raw.replaceAll(this.config.copilotGithubToken, "[REDACTED]").slice(0, 4000);
	}
}
