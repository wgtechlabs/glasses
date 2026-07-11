import crypto from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { Delegation, TranscriptEntry, WorkerSummary } from "./runner-protocol";
import type { Conversation, ConversationStatus, Job } from "./types";

const id = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

export class Database {
	private pool: Pool;

	constructor(databaseUrl: string) {
		this.pool = new Pool({ connectionString: databaseUrl });
	}

	async initialize(): Promise<void> {
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS conversations (
				id TEXT PRIMARY KEY,
				channel TEXT NOT NULL,
				user_id TEXT NOT NULL,
				agent TEXT NOT NULL DEFAULT 'copilot',
				repository TEXT NOT NULL DEFAULT '',
				sandbox_id TEXT,
				session_id TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_id TEXT;
			ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversation_kind TEXT NOT NULL DEFAULT 'main';
			ALTER TABLE conversations ADD COLUMN IF NOT EXISTS copilot_session_id TEXT;
			ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

			CREATE TABLE IF NOT EXISTS messages (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL REFERENCES conversations(id),
				channel TEXT NOT NULL,
				user_id TEXT NOT NULL,
				content TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			ALTER TABLE messages ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
			ALTER TABLE messages ADD COLUMN IF NOT EXISTS external_id TEXT;

			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY,
				conversation_id TEXT NOT NULL REFERENCES conversations(id),
				prompt TEXT NOT NULL,
				status TEXT NOT NULL,
				result TEXT,
				error TEXT,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			);
			ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'main_turn';
			ALTER TABLE jobs ADD COLUMN IF NOT EXISTS repository TEXT;
			ALTER TABLE jobs ADD COLUMN IF NOT EXISTS sandbox_id TEXT;
			ALTER TABLE jobs ADD COLUMN IF NOT EXISTS exec_session_name TEXT;
			ALTER TABLE jobs ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
			ALTER TABLE jobs ADD COLUMN IF NOT EXISTS parent_job_id TEXT REFERENCES jobs(id);
			ALTER TABLE jobs ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

			CREATE TABLE IF NOT EXISTS user_instructions (
				channel TEXT NOT NULL,
				user_id TEXT NOT NULL,
				content TEXT NOT NULL,
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				PRIMARY KEY (channel, user_id)
			);

			UPDATE jobs
			SET status = 'failed', error = 'Orphaned legacy running job.', updated_at = NOW()
			WHERE status = 'running' AND claimed_at IS NULL;

			CREATE INDEX IF NOT EXISTS idx_conversations_user_channel
				ON conversations(user_id, channel);
			CREATE UNIQUE INDEX IF NOT EXISTS uq_main_conversation_chat
				ON conversations(channel, user_id, chat_id)
				WHERE conversation_kind = 'main' AND chat_id IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_messages_conversation_recent
				ON messages(conversation_id, created_at DESC);
			CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_external
				ON messages(channel, external_id) WHERE external_id IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_jobs_claim
				ON jobs(status, kind, created_at);
			CREATE INDEX IF NOT EXISTS idx_jobs_conversation
				ON jobs(conversation_id, status, kind);
			CREATE UNIQUE INDEX IF NOT EXISTS uq_running_main_job
				ON jobs(conversation_id)
				WHERE status = 'running' AND kind IN ('main_turn', 'worker_result');
			CREATE UNIQUE INDEX IF NOT EXISTS uq_running_worker_repository
				ON jobs(conversation_id, repository)
				WHERE status = 'running' AND kind = 'worker';
		`);
	}

	async enqueueTelegramTurn(input: {
		userId: string;
		chatId: string;
		telegramMessageId: number;
		prompt: string;
	}): Promise<{ conversation: Conversation; job: Job | null }> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const now = new Date();
			const conversationId = id("conv");
			await client.query(
				`UPDATE conversations SET
					chat_id = $2, conversation_kind = 'main', agent = 'copilot', repository = '',
					sandbox_id = NULL, session_id = NULL, copilot_session_id = NULL,
					last_activity_at = $3, updated_at = $3
				WHERE id = (
					SELECT id FROM conversations
					WHERE channel = 'telegram' AND user_id = $1 AND chat_id IS NULL
					ORDER BY updated_at DESC
					FOR UPDATE SKIP LOCKED
					LIMIT 1
				)
				AND NOT EXISTS (
					SELECT 1 FROM conversations
					WHERE channel = 'telegram' AND user_id = $1 AND chat_id = $2
						AND conversation_kind = 'main'
				)`,
				[input.userId, input.chatId, now],
			);
			const { rows: conversations } = await client.query(
				`INSERT INTO conversations (
					id, channel, user_id, chat_id, conversation_kind, agent, repository,
					sandbox_id, session_id, copilot_session_id, last_activity_at, created_at, updated_at
				) VALUES ($1, 'telegram', $2, $3, 'main', 'copilot', '', NULL, NULL, NULL, $4, $4, $4)
				ON CONFLICT (channel, user_id, chat_id)
					WHERE conversation_kind = 'main' AND chat_id IS NOT NULL
				DO UPDATE SET last_activity_at = EXCLUDED.last_activity_at, updated_at = EXCLUDED.updated_at
				RETURNING *`,
				[conversationId, input.userId, input.chatId, now],
			);
			const conversation = rowToConversation(conversations[0]);
			const externalId = `${input.chatId}:${input.telegramMessageId}`;
			const messageId = id("msg");
			const { rowCount } = await client.query(
				`INSERT INTO messages (
					id, conversation_id, channel, user_id, role, content, external_id, created_at
				) VALUES ($1, $2, 'telegram', $3, 'user', $4, $5, $6)
				ON CONFLICT (channel, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
				[messageId, conversation.id, input.userId, input.prompt, externalId, now],
			);
			let job: Job | null = null;
			if (rowCount === 1) {
				const jobId = id("job");
				const { rows } = await client.query(
					`INSERT INTO jobs (
						id, conversation_id, kind, prompt, status, metadata, created_at, updated_at
					) VALUES ($1, $2, 'main_turn', $3, 'pending', '{}'::jsonb, $4, $4)
					RETURNING *`,
					[jobId, conversation.id, input.prompt, now],
				);
				job = rowToJob(rows[0]);
			}
			await client.query("COMMIT");
			return { conversation, job };
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async getConversation(idValue: string): Promise<Conversation | null> {
		const { rows } = await this.pool.query("SELECT * FROM conversations WHERE id = $1", [idValue]);
		return rows[0] ? rowToConversation(rows[0]) : null;
	}

	async getMainConversation(
		channel: string,
		userId: string,
		chatId: string,
	): Promise<Conversation | null> {
		const { rows } = await this.pool.query(
			`SELECT * FROM conversations
			WHERE channel = $1 AND user_id = $2 AND chat_id = $3 AND conversation_kind = 'main'
			LIMIT 1`,
			[channel, userId, chatId],
		);
		return rows[0] ? rowToConversation(rows[0]) : null;
	}

	async updateConversationRuntime(
		conversationId: string,
		sandboxId: string | null,
		copilotSessionId: string | null,
	): Promise<void> {
		await this.pool.query(
			`UPDATE conversations SET
				sandbox_id = $2, copilot_session_id = $3, session_id = $3,
				last_activity_at = NOW(), updated_at = NOW()
			WHERE id = $1`,
			[conversationId, sandboxId, copilotSessionId],
		);
	}

	async getRecentTranscript(conversationId: string, limit: number): Promise<TranscriptEntry[]> {
		const { rows } = await this.pool.query(
			`SELECT role, content FROM (
				SELECT role, content, created_at FROM messages
				WHERE conversation_id = $1
				ORDER BY created_at DESC
				LIMIT $2
			) recent ORDER BY created_at ASC`,
			[conversationId, limit],
		);
		return rows.map((row) => ({ role: row.role, content: row.content }));
	}

	async getRecentWorkerSummaries(conversationId: string, limit: number): Promise<WorkerSummary[]> {
		if (limit === 0) return [];
		const { rows } = await this.pool.query(
			`SELECT repository, status, COALESCE(result, error, '') AS summary
			FROM jobs
			WHERE conversation_id = $1 AND kind = 'worker' AND status IN ('done', 'failed')
			ORDER BY updated_at DESC LIMIT $2`,
			[conversationId, limit],
		);
		return rows.map((row) => ({
			repository: row.repository,
			status: row.status,
			summary: row.summary,
		}));
	}

	async claimMainJob(): Promise<Job | null> {
		return this.claim(`
			SELECT j.id FROM jobs j
			JOIN conversations c ON c.id = j.conversation_id
			WHERE j.status = 'pending' AND j.kind IN ('main_turn', 'worker_result')
				AND NOT EXISTS (
					SELECT 1 FROM jobs active
					WHERE active.conversation_id = j.conversation_id
						AND active.status = 'running'
						AND active.kind IN ('main_turn', 'worker_result')
				)
			ORDER BY j.created_at
			FOR UPDATE OF j, c SKIP LOCKED
			LIMIT 1
		`);
	}

	async claimWorkerJob(): Promise<Job | null> {
		return this.claim(`
			SELECT j.id FROM jobs j
			JOIN conversations c ON c.id = j.conversation_id
			WHERE j.status = 'pending' AND j.kind = 'worker'
				AND NOT EXISTS (
					SELECT 1 FROM jobs active
					WHERE active.conversation_id = j.conversation_id
						AND active.repository = j.repository
						AND active.status = 'running' AND active.kind = 'worker'
				)
				AND j.id = (
					SELECT earliest.id FROM jobs earliest
					WHERE earliest.conversation_id = j.conversation_id
						AND earliest.repository = j.repository
						AND earliest.status = 'pending' AND earliest.kind = 'worker'
					ORDER BY earliest.created_at LIMIT 1
				)
			ORDER BY j.created_at
			FOR UPDATE OF j, c SKIP LOCKED
			LIMIT 1
		`);
	}

	private async claim(selectionSql: string): Promise<Job | null> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const { rows: selected } = await client.query(selectionSql);
			if (!selected[0]) {
				await client.query("COMMIT");
				return null;
			}
			const { rows } = await client.query(
				`UPDATE jobs SET status = 'running', claimed_at = NOW(), updated_at = NOW()
				WHERE id = $1 RETURNING *`,
				[selected[0].id],
			);
			await client.query("COMMIT");
			return rowToJob(rows[0]);
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async setJobExecution(jobId: string, sandboxId: string, execSessionName?: string): Promise<void> {
		await this.pool.query(
			`UPDATE jobs SET sandbox_id = $2,
				exec_session_name = COALESCE($3, exec_session_name), updated_at = NOW()
			WHERE id = $1 AND status = 'running'`,
			[jobId, sandboxId, execSessionName ?? null],
		);
	}

	async setJobExecSession(jobId: string, execSessionName: string): Promise<void> {
		await this.pool.query(
			`UPDATE jobs SET exec_session_name = $2, updated_at = NOW()
			WHERE id = $1 AND status = 'running'`,
			[jobId, execSessionName],
		);
	}

	async requeueWorkerDelivery(input: {
		job: Job;
		checkpointName: string;
		workerOutput: string;
		workerBranch: string;
	}): Promise<void> {
		const metadata = {
			...input.job.metadata,
			deliveryOnly: true,
			checkpointName: input.checkpointName,
			workerOutput: input.workerOutput,
			workerBranch: input.workerBranch,
		};
		await this.pool.query(
			`UPDATE jobs SET status = 'pending', result = NULL, error = NULL,
				sandbox_id = NULL, exec_session_name = NULL, claimed_at = NULL,
				metadata = $2::jsonb, updated_at = NOW()
			WHERE id = $1 AND status = 'running'`,
			[input.job.id, JSON.stringify(metadata)],
		);
	}

	async requeueFailedWorkerDeliveries(): Promise<void> {
		await this.pool.query(
			`UPDATE jobs SET status = 'pending', error = NULL, claimed_at = NULL, updated_at = NOW()
			WHERE kind = 'worker' AND status = 'failed'
				AND metadata->>'deliveryOnly' = 'true'
				AND metadata->>'checkpointName' IS NOT NULL`,
		);
	}

	async completeMainJob(input: {
		job: Job;
		output: string;
		sessionId: string | null;
		sandboxId: string;
		delegations: Delegation[];
	}): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const { rowCount: completed } = await client.query(
				`UPDATE jobs SET status = 'done', result = $2, error = NULL, updated_at = NOW()
				WHERE id = $1 AND status = 'running'`,
				[input.job.id, input.output],
			);
			if (completed !== 1) {
				await client.query("ROLLBACK");
				return;
			}
			await client.query(
				`UPDATE conversations SET sandbox_id = $2, copilot_session_id = $3, session_id = $3,
					last_activity_at = NOW(), updated_at = NOW()
				WHERE id = $1 AND sandbox_id = $2`,
				[input.job.conversationId, input.sandboxId, input.sessionId],
			);
			const conversation = await this.getConversationWithClient(client, input.job.conversationId);
			await client.query(
				`INSERT INTO messages (
					id, conversation_id, channel, user_id, role, content, external_id, created_at
				) VALUES ($1, $2, $3, $4, 'assistant', $5, NULL, NOW())`,
				[id("msg"), conversation.id, conversation.channel, conversation.userId, input.output],
			);
			for (const delegation of input.delegations) {
				await client.query(
					`INSERT INTO jobs (
						id, conversation_id, kind, prompt, repository, status, parent_job_id,
						metadata, created_at, updated_at
					) VALUES ($1, $2, 'worker', $3, $4, 'pending', $5, '{}'::jsonb, NOW(), NOW())`,
					[
						id("job"),
						input.job.conversationId,
						delegation.task,
						delegation.repository,
						input.job.id,
					],
				);
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async finishWorkerAndEnqueueResult(input: {
		job: Job;
		status: "done" | "failed";
		result: string | null;
		error: string | null;
	}): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const { rowCount: completed } = await client.query(
				`UPDATE jobs SET status = $2, result = $3, error = $4,
					metadata = CASE WHEN $2 = 'done'
						THEN metadata - 'deliveryOnly' - 'checkpointName' - 'workerOutput' - 'workerBranch'
						ELSE metadata
					END,
					updated_at = NOW()
				WHERE id = $1 AND status = 'running'`,
				[input.job.id, input.status, input.result, input.error],
			);
			if (completed !== 1) {
				await client.query("ROLLBACK");
				return;
			}
			const summary = input.result ?? input.error ?? "No worker result was produced.";
			const prompt = `Repository worker ${input.status} for ${input.job.repository}.
Give the user a concise, coherent update based only on this worker result:

${summary}`;
			await client.query(
				`INSERT INTO jobs (
					id, conversation_id, kind, prompt, status, parent_job_id, metadata,
					created_at, updated_at
				) VALUES ($1, $2, 'worker_result', $3, 'pending', $4, $5::jsonb, NOW(), NOW())`,
				[
					id("job"),
					input.job.conversationId,
					prompt,
					input.job.id,
					JSON.stringify({
						repository: input.job.repository,
						workerStatus: input.status,
					}),
				],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async failJob(jobId: string, error: string): Promise<void> {
		await this.pool.query(
			`UPDATE jobs SET status = 'failed', error = $2, updated_at = NOW()
			WHERE id = $1 AND status = 'running'`,
			[jobId, error],
		);
	}

	async getRunningJobs(): Promise<Job[]> {
		const { rows } = await this.pool.query(
			"SELECT * FROM jobs WHERE status = 'running' ORDER BY claimed_at",
		);
		return rows.map(rowToJob);
	}

	async getStatus(channel: string, userId: string, chatId: string): Promise<ConversationStatus> {
		const conversation = await this.getMainConversation(channel, userId, chatId);
		if (!conversation) {
			return {
				conversation: null,
				pendingMain: 0,
				runningMain: 0,
				pendingWorkers: 0,
				runningWorkers: 0,
			};
		}
		const { rows } = await this.pool.query(
			`SELECT
				COUNT(*) FILTER (
					WHERE status = 'pending' AND kind IN ('main_turn', 'worker_result')
				)::int AS pending_main,
				COUNT(*) FILTER (
					WHERE status = 'running' AND kind IN ('main_turn', 'worker_result')
				)::int AS running_main,
				COUNT(*) FILTER (WHERE status = 'pending' AND kind = 'worker')::int AS pending_workers,
				COUNT(*) FILTER (WHERE status = 'running' AND kind = 'worker')::int AS running_workers
			FROM jobs WHERE conversation_id = $1`,
			[conversation.id],
		);
		return {
			conversation,
			pendingMain: rows[0].pending_main,
			runningMain: rows[0].running_main,
			pendingWorkers: rows[0].pending_workers,
			runningWorkers: rows[0].running_workers,
		};
	}

	async getInstructions(channel: string, userId: string): Promise<string | null> {
		const { rows } = await this.pool.query(
			"SELECT content FROM user_instructions WHERE channel = $1 AND user_id = $2",
			[channel, userId],
		);
		return rows[0]?.content ?? null;
	}

	async changeInstructions(input: {
		channel: string;
		userId: string;
		content: string | null;
	}): Promise<string[]> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			if (input.content === null) {
				await client.query("DELETE FROM user_instructions WHERE channel = $1 AND user_id = $2", [
					input.channel,
					input.userId,
				]);
			} else {
				await client.query(
					`INSERT INTO user_instructions (channel, user_id, content, updated_at)
					VALUES ($1, $2, $3, NOW())
					ON CONFLICT (channel, user_id)
					DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()`,
					[input.channel, input.userId, input.content],
				);
			}
			const { rows: current } = await client.query(
				`SELECT sandbox_id FROM conversations
				WHERE channel = $1 AND user_id = $2 AND conversation_kind = 'main'
				FOR UPDATE`,
				[input.channel, input.userId],
			);
			await client.query(
				`UPDATE conversations SET sandbox_id = NULL, copilot_session_id = NULL,
					session_id = NULL, updated_at = NOW()
				WHERE channel = $1 AND user_id = $2 AND conversation_kind = 'main'`,
				[input.channel, input.userId],
			);
			const sandboxIds = current
				.map((row) => row.sandbox_id as string | null)
				.filter((sandboxId): sandboxId is string => Boolean(sandboxId));
			await client.query("COMMIT");
			return sandboxIds;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	private async getConversationWithClient(
		client: PoolClient,
		conversationId: string,
	): Promise<Conversation> {
		const { rows } = await client.query("SELECT * FROM conversations WHERE id = $1", [
			conversationId,
		]);
		if (!rows[0]) throw new Error("Conversation not found.");
		return rowToConversation(rows[0]);
	}

	async close(): Promise<void> {
		await this.pool.end();
	}
}

function rowToConversation(row: Record<string, unknown>): Conversation {
	return {
		id: row.id as string,
		channel: row.channel as Conversation["channel"],
		userId: row.user_id as string,
		chatId: (row.chat_id as string) ?? (row.user_id as string),
		sandboxId: (row.sandbox_id as string) ?? null,
		copilotSessionId: (row.copilot_session_id as string) ?? (row.session_id as string) ?? null,
		lastActivityAt: row.last_activity_at as Date,
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}

function rowToJob(row: Record<string, unknown>): Job {
	return {
		id: row.id as string,
		conversationId: row.conversation_id as string,
		kind: row.kind as Job["kind"],
		prompt: row.prompt as string,
		repository: (row.repository as string) ?? null,
		status: row.status as Job["status"],
		result: (row.result as string) ?? null,
		error: (row.error as string) ?? null,
		sandboxId: (row.sandbox_id as string) ?? null,
		execSessionName: (row.exec_session_name as string) ?? null,
		parentJobId: (row.parent_job_id as string) ?? null,
		claimedAt: (row.claimed_at as Date) ?? null,
		metadata: (row.metadata as Record<string, unknown>) ?? {},
		createdAt: row.created_at as Date,
		updatedAt: row.updated_at as Date,
	};
}
