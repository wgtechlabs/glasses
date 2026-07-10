export type ChannelName = "telegram" | "discord" | "whatsapp";
export type MessageRole = "user" | "assistant" | "system";
export type JobKind = "main_turn" | "worker" | "worker_result";
export type JobStatus = "pending" | "running" | "done" | "failed";

export interface Message {
	id: string;
	conversationId: string;
	channel: ChannelName;
	userId: string;
	role: MessageRole;
	content: string;
	externalId: string | null;
	createdAt: Date;
}

export interface Conversation {
	id: string;
	channel: ChannelName;
	userId: string;
	chatId: string;
	sandboxId: string | null;
	copilotSessionId: string | null;
	lastActivityAt: Date;
	createdAt: Date;
	updatedAt: Date;
}

export interface Job {
	id: string;
	conversationId: string;
	kind: JobKind;
	prompt: string;
	repository: string | null;
	status: JobStatus;
	result: string | null;
	error: string | null;
	sandboxId: string | null;
	execSessionName: string | null;
	parentJobId: string | null;
	claimedAt: Date | null;
	metadata: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
}

export interface ConversationStatus {
	conversation: Conversation | null;
	pendingMain: number;
	runningMain: number;
	pendingWorkers: number;
	runningWorkers: number;
}

export interface Config {
	railwayApiToken: string;
	railwayEnvironmentId: string;
	databaseUrl: string;
	telegramBotToken: string;
	telegramAllowedUserId: string;
	copilotGithubToken: string;
	mainSandboxIdleMinutes: number;
	memoryMessageLimit: number;
	memoryWorkerLimit: number;
	schedulerPollMs: number;
	schedulerWorkerConcurrency: number;
	jobTimeoutSeconds: number;
	port: number;
	logLevel: "debug" | "info" | "warn" | "error";
}
