import crypto from "node:crypto";
import { repositoryPath } from "../agents/paths";
import type { AgentRegistry } from "../agents/registry";
import type { Database } from "../db";
import { logger } from "../logger";
import type { SandboxManager } from "../sandbox";
import type { AgentName, Conversation } from "../types";
import type { ChannelLike } from "./types";

interface TelegramUpdate {
	message?: {
		message_id: number;
		from: { id: number };
		chat: { id: number };
		text?: string;
	};
}

const KNOWN_AGENTS: AgentName[] = ["copilot", "devin"];

/**
 * Telegram webhook handler. Maps a Telegram chat 1:1 with a conversation:
 * `/new owner/repo [agent]` provisions a sandbox and clones the repo,
 * plain messages are forwarded as prompts to whichever agent that
 * conversation was created with — mirroring how you'd type into the CLI
 * directly, just over chat.
 */
export class TelegramChannel implements ChannelLike {
	readonly name = "telegram";

	constructor(
		private botToken: string,
		private allowedUserId: string,
		private db: Database,
		private agents: AgentRegistry,
		private sandbox: SandboxManager,
	) {}

	async registerWebhook(publicDomain?: string): Promise<void> {
		if (!publicDomain) return;

		const webhookUrl = `https://${publicDomain}/webhook/telegram`;
		const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setWebhook`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: webhookUrl }),
		});

		if (!response.ok) {
			throw new Error(`Telegram setWebhook failed with status ${response.status}`);
		}

		logger.info("Telegram webhook registered", { webhookUrl });
	}

	async handleWebhook(payload: unknown): Promise<void> {
		const update = payload as TelegramUpdate;
		const message = update.message;

		if (!message?.text) {
			logger.debug("Ignoring update with no text message");
			return;
		}

		const userId = String(message.from.id);
		const chatId = message.chat.id;
		const text = message.text.trim();

		if (userId !== this.allowedUserId) {
			logger.warn("Rejected message from unauthorized user", { userId });
			await this.sendMessage(chatId, "Unauthorized.");
			return;
		}

		logger.info("Received telegram message", { userId, preview: text.slice(0, 50) });

		if (text.startsWith("/new")) {
			await this.handleNew(chatId, userId, text);
			return;
		}

		if (text.startsWith("/status")) {
			await this.handleStatus(chatId, userId);
			return;
		}

		await this.handlePrompt(chatId, userId, text);
	}

	private async handleNew(chatId: number, userId: string, text: string): Promise<void> {
		const [, repository, agentArg] = text.split(/\s+/);
		const agentName = (agentArg || "copilot") as AgentName;

		if (!repository || !repository.includes("/")) {
			await this.sendMessage(chatId, "Usage: /new owner/repository [copilot|devin]");
			return;
		}

		if (!KNOWN_AGENTS.includes(agentName)) {
			await this.sendMessage(
				chatId,
				`Unknown agent "${agentName}". Available: ${this.agents.names().join(", ")}`,
			);
			return;
		}

		const agent = this.agents.get(agentName);
		if (!agent) {
			await this.sendMessage(chatId, `Agent "${agentName}" is not registered.`);
			return;
		}

		await this.sendMessage(chatId, `Starting a sandbox for ${repository} with ${agentName}...`);

		try {
			const sandboxId = await this.sandbox.create();
			await agent.ensureReady(sandboxId, repository);

			const now = new Date();
			const conversation: Conversation = {
				id: `conv_${crypto.randomUUID()}`,
				channel: "telegram",
				userId,
				agent: agentName,
				repository,
				sandboxId,
				sessionId: null,
				createdAt: now,
				updatedAt: now,
			};

			await this.db.saveConversation(conversation);
			await this.sendMessage(
				chatId,
				`Ready. Cloned ${repository} into a sandbox running ${agentName}. Send a message to start prompting it.`,
			);
		} catch (error) {
			logger.error("Failed to start a new conversation", error);
			await this.sendMessage(chatId, "Failed to start a new session. Check gateway logs.");
		}
	}

	private async handleStatus(chatId: number, userId: string): Promise<void> {
		const conversation = await this.db.getLatestConversationForUser(userId, "telegram");

		if (!conversation) {
			await this.sendMessage(
				chatId,
				"No active session. Use /new owner/repository [agent] to start one.",
			);
			return;
		}

		await this.sendMessage(
			chatId,
			`Agent: ${conversation.agent}\nRepository: ${conversation.repository}\nSandbox: ${conversation.sandboxId}\nLast updated: ${conversation.updatedAt.toISOString()}`,
		);
	}

	private async handlePrompt(chatId: number, userId: string, prompt: string): Promise<void> {
		const conversation = await this.db.getLatestConversationForUser(userId, "telegram");

		if (!conversation || !conversation.sandboxId) {
			await this.sendMessage(
				chatId,
				"No active session. Use /new owner/repository [agent] to start one.",
			);
			return;
		}

		const agent = this.agents.get(conversation.agent);
		if (!agent) {
			await this.sendMessage(chatId, `Agent "${conversation.agent}" is not registered.`);
			return;
		}

		await this.db.saveMessage({
			id: `msg_${crypto.randomUUID()}`,
			conversationId: conversation.id,
			channel: "telegram",
			userId,
			content: prompt,
			createdAt: new Date(),
		});

		try {
			const result = await agent.send({
				sandboxId: conversation.sandboxId,
				repository: conversation.repository,
				repositoryPath: repositoryPath(conversation.repository),
				prompt,
				conversationSessionId: conversation.sessionId,
			});

			await this.db.saveConversation({
				...conversation,
				sessionId: result.sessionId,
				updatedAt: new Date(),
			});

			await this.sendMessage(chatId, result.output || "(no output)");
		} catch (error) {
			logger.error("Agent turn failed", error);
			await this.sendMessage(chatId, "The agent hit an unexpected error. Check gateway logs.");
		}
	}

	private async sendMessage(chatId: number, text: string): Promise<void> {
		const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

		try {
			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chat_id: chatId, text }),
			});

			if (!response.ok) {
				logger.error("Telegram sendMessage failed", { status: response.status });
			}
		} catch (error) {
			logger.error("Telegram sendMessage threw", error);
		}
	}
}
