import { createHash, timingSafeEqual } from "node:crypto";
import type { Database } from "../db";
import { logger } from "../logger";
import type { ChatNotifier, Scheduler } from "../scheduler";
import type { ChannelLike } from "./types";

interface TelegramUpdate {
	message?: {
		message_id: number;
		from?: { id: number };
		chat?: { id: number };
		text?: string;
	};
}

export interface TelegramSender {
	send(chatId: string, text: string): Promise<void>;
}

export class TelegramMessenger implements TelegramSender, ChatNotifier {
	private readonly webhookSecret: string;

	constructor(private botToken: string) {
		this.webhookSecret = createHash("sha256")
			.update(`glasses-telegram-webhook:${botToken}`)
			.digest("hex");
	}

	async registerWebhook(publicDomain?: string): Promise<void> {
		if (!publicDomain) return;

		const response = await fetch(`https://api.telegram.org/bot${this.botToken}/setWebhook`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				url: `https://${publicDomain}/webhook/telegram`,
				secret_token: this.webhookSecret,
			}),
		});
		if (!response.ok) {
			throw new Error(`Telegram setWebhook failed with status ${response.status}.`);
		}

		const commandsResponse = await fetch(
			`https://api.telegram.org/bot${this.botToken}/setMyCommands`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					commands: [
						{ command: "status", description: "Show main session and queued work" },
						{ command: "instructions", description: "Show or update global instructions" },
					],
				}),
			},
		);
		if (!commandsResponse.ok) {
			throw new Error(`Telegram setMyCommands failed with status ${commandsResponse.status}.`);
		}
	}

	isValidWebhookSecret(secret: string): boolean {
		const actual = Buffer.from(secret);
		const expected = Buffer.from(this.webhookSecret);
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	}

	async send(chatId: string, text: string): Promise<void> {
		const parts = splitTelegramMessage(text || "(no output)");
		for (const part of parts) {
			try {
				const response = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chat_id: chatId, text: part }),
				});
				if (!response.ok) {
					logger.error("Telegram sendMessage failed", { status: response.status });
				}
			} catch (error) {
				logger.error("Telegram sendMessage threw", {
					reason: error instanceof Error ? error.name : "unknown",
				});
			}
		}
	}
}

export class TelegramChannel implements ChannelLike {
	readonly name = "telegram";

	constructor(
		private allowedUserId: string,
		private db: Database,
		private scheduler: Scheduler,
		private sender: TelegramSender,
	) {}

	async handleWebhook(payload: unknown): Promise<void> {
		const update = payload as TelegramUpdate;
		const message = update?.message;
		if (
			!message?.text ||
			!message.from ||
			!message.chat ||
			!Number.isSafeInteger(message.message_id)
		) {
			logger.debug("Ignoring malformed or non-text Telegram update");
			return;
		}

		const userId = String(message.from.id);
		const chatId = String(message.chat.id);
		const text = message.text.trim();
		if (!text) return;
		if (userId !== this.allowedUserId) {
			logger.warn("Rejected Telegram message from unauthorized user", { userId });
			await this.sender.send(chatId, "Unauthorized.");
			return;
		}

		const rawCommand = text.split(/\s+/, 1)[0] ?? "";
		const command = rawCommand.split("@", 1)[0]?.toLowerCase();
		if (command === "/new") {
			await this.sender.send(
				chatId,
				"No /new command is needed. Send the repository and task naturally (for example: “Fix owner/repo issue #42”).",
			);
			return;
		}
		if (command === "/status") {
			await this.handleStatus(chatId, userId);
			return;
		}
		if (command === "/instructions") {
			await this.handleInstructions(chatId, userId, text.slice(rawCommand.length).trim());
			return;
		}

		const queued = await this.db.enqueueTelegramTurn({
			userId,
			chatId,
			telegramMessageId: message.message_id,
			prompt: text,
		});
		if (!queued.job) return;
		void this.sender.send(chatId, "Accepted. Your request is queued.");
		this.scheduler.kick();
	}

	private async handleStatus(chatId: string, userId: string): Promise<void> {
		const status = await this.db.getStatus("telegram", userId, chatId);
		if (!status.conversation) {
			await this.sender.send(
				chatId,
				"No main session yet. Send a repository and task naturally to start one.",
			);
			return;
		}
		await this.sender.send(
			chatId,
			[
				`Main sandbox: ${status.conversation.sandboxId ?? "inactive (created on next turn)"}`,
				`Main turns: ${status.runningMain} running, ${status.pendingMain} queued`,
				`Workers: ${status.runningWorkers} running, ${status.pendingWorkers} queued`,
				`Last activity: ${status.conversation.lastActivityAt.toISOString()}`,
			].join("\n"),
		);
	}

	private async handleInstructions(
		chatId: string,
		userId: string,
		argumentsText: string,
	): Promise<void> {
		if (!argumentsText) {
			const instructions = await this.db.getInstructions("telegram", userId);
			await this.sender.send(
				chatId,
				instructions ? `Global instructions:\n${instructions}` : "No global instructions set.",
			);
			return;
		}

		if (argumentsText.toLowerCase() === "clear") {
			const sandboxIds = await this.db.changeInstructions({
				channel: "telegram",
				userId,
				content: null,
			});
			for (const sandboxId of sandboxIds) {
				await this.scheduler.invalidateMainSandbox(sandboxId);
			}
			await this.sender.send(
				chatId,
				"Global instructions cleared. The main sandbox will be recreated on the next turn.",
			);
			return;
		}

		if (argumentsText.toLowerCase().startsWith("set ")) {
			const content = argumentsText.slice(4).trim();
			if (!content) {
				await this.sender.send(chatId, "Usage: /instructions set <text>");
				return;
			}
			if (content.length > 20_000) {
				await this.sender.send(chatId, "Instructions are too long (maximum 20,000 characters).");
				return;
			}
			const sandboxIds = await this.db.changeInstructions({
				channel: "telegram",
				userId,
				content,
			});
			for (const sandboxId of sandboxIds) {
				await this.scheduler.invalidateMainSandbox(sandboxId);
			}
			await this.sender.send(
				chatId,
				"Global instructions saved. The main sandbox will be recreated on the next turn.",
			);
			return;
		}

		await this.sender.send(
			chatId,
			"Usage: /instructions | /instructions set <text> | /instructions clear",
		);
	}
}

export function splitTelegramMessage(text: string, limit = 4000): string[] {
	if (text.length <= limit) return [text];
	const parts: string[] = [];
	let remaining = text;
	while (remaining.length > limit) {
		const newline = remaining.lastIndexOf("\n", limit);
		const splitAt = newline > limit / 2 ? newline : limit;
		parts.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).replace(/^\n/, "");
	}
	if (remaining) parts.push(remaining);
	return parts;
}
