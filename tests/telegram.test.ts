import { describe, expect, it, mock } from "bun:test";
import { TelegramChannel, type TelegramSender } from "../src/channels/telegram";
import type { Database } from "../src/db";
import type { Scheduler } from "../src/scheduler";

function payload(text: string, messageId = 1) {
	return {
		message: {
			message_id: messageId,
			from: { id: 123 },
			chat: { id: 456 },
			text,
		},
	};
}

function setup(overrides: Record<string, unknown> = {}) {
	const sent: string[] = [];
	const sender: TelegramSender = {
		send: mock(async (_chatId, text) => {
			sent.push(text);
		}),
	};
	const db = {
		enqueueTelegramTurn: mock(async () => ({
			conversation: { id: "conv-1" },
			job: { id: "job-1" },
		})),
		getStatus: mock(async () => ({ conversation: null })),
		getMainConversation: mock(async () => null),
		configureMainConversation: mock(async () => ({
			conversation: {
				id: "conv-1",
				agent: "copilot",
				repository: "wgtechlabs/glasses",
				model: null,
			},
			previousSandboxId: "sbx-main-old",
		})),
		getInstructions: mock(async () => null),
		changeInstructions: mock(async () => ["sbx-old"]),
		...overrides,
	} as unknown as Database;
	const scheduler = {
		kick: mock(() => undefined),
		invalidateMainSandbox: mock(async () => undefined),
	} as unknown as Scheduler;
	return { channel: new TelegramChannel("123", db, scheduler, sender), db, scheduler, sent };
}

describe("Telegram control chat", () => {
	it("auto-creates/enqueues the first plain message without a harness reply", async () => {
		const { channel, db, scheduler, sent } = setup();
		await channel.handleWebhook(payload("Please fix wgtechlabs/glasses"));
		expect(db.enqueueTelegramTurn).toHaveBeenCalledWith({
			userId: "123",
			chatId: "456",
			telegramMessageId: 1,
			prompt: "Please fix wgtechlabs/glasses",
			agent: "copilot",
		});
		expect(scheduler.kick).toHaveBeenCalled();
		expect(sent).toEqual([]);
	});

	it("prompts for /cli choice when both CLIs are available and no default exists", async () => {
		const { db, scheduler, sent } = setup();
		const both = new TelegramChannel(
			"123",
			db,
			scheduler,
			{
				send: mock(async (_chatId, text) => {
					sent.push(text);
				}),
			},
			{
				copilot: true,
				devin: true,
			},
		);
		await both.handleWebhook(payload("Please fix wgtechlabs/glasses"));
		expect(db.enqueueTelegramTurn).not.toHaveBeenCalled();
		expect(sent[0]).toContain("/cli copilot");
	});

	it("configures /new session settings", async () => {
		const { db, scheduler, sent } = setup();
		const channel = new TelegramChannel(
			"123",
			db,
			scheduler,
			{
				send: mock(async (_chatId, text) => {
					sent.push(text);
				}),
			},
			{
				copilot: true,
				devin: true,
			},
		);
		await channel.handleWebhook(payload("/new owner/repo devin"));
		expect(db.configureMainConversation).toHaveBeenCalledWith({
			channel: "telegram",
			userId: "123",
			chatId: "456",
			agent: "devin",
			repository: "owner/repo",
			model: "swe-1.7",
		});
		expect(scheduler.invalidateMainSandbox).toHaveBeenCalledWith("sbx-main-old");
		expect(sent[0]).toContain("Session configured");
	});

	it("shows and updates /cli defaults", async () => {
		const { channel, db, sent } = setup({
			getMainConversation: mock(async () => ({
				id: "conv-1",
				channel: "telegram",
				userId: "123",
				chatId: "456",
				agent: "devin",
				repository: "owner/repo",
				model: "swe-1.7",
				sandboxId: null,
				copilotSessionId: null,
				lastActivityAt: new Date(),
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
		});

		await channel.handleWebhook(payload("/cli", 2));
		await channel.handleWebhook(payload("/cli copilot", 3));

		expect(sent[0]).toContain("Active CLI: devin");
		expect(db.configureMainConversation).toHaveBeenCalledWith({
			channel: "telegram",
			userId: "123",
			chatId: "456",
			agent: "copilot",
			repository: "owner/repo",
			model: null,
		});
	});

	it("shows and updates /model", async () => {
		const { channel, db, sent } = setup({
			getMainConversation: mock(async () => ({
				id: "conv-1",
				channel: "telegram",
				userId: "123",
				chatId: "456",
				agent: "devin",
				repository: "owner/repo",
				model: "swe-1.7",
				sandboxId: null,
				copilotSessionId: null,
				lastActivityAt: new Date(),
				createdAt: new Date(),
				updatedAt: new Date(),
			})),
		});

		await channel.handleWebhook(payload("/model", 2));
		await channel.handleWebhook(payload("/model swe-1.8", 3));

		expect(sent[0]).toContain("swe-1.7");
		expect(db.configureMainConversation).toHaveBeenCalledWith({
			channel: "telegram",
			userId: "123",
			chatId: "456",
			agent: "devin",
			repository: "owner/repo",
			model: "swe-1.8",
		});
	});

	it("shows, sets, and clears global instructions", async () => {
		const { channel, db, scheduler, sent } = setup({
			getInstructions: mock(async () => "Keep changes minimal."),
		});
		await channel.handleWebhook(payload("/instructions", 1));
		await channel.handleWebhook(payload("/instructions set Run tests", 2));
		await channel.handleWebhook(payload("/instructions clear", 3));
		expect(sent[0]).toContain("Keep changes minimal");
		expect(db.changeInstructions).toHaveBeenNthCalledWith(1, {
			channel: "telegram",
			userId: "123",
			content: "Run tests",
		});
		expect(db.changeInstructions).toHaveBeenNthCalledWith(2, {
			channel: "telegram",
			userId: "123",
			content: null,
		});
		expect(scheduler.invalidateMainSandbox).toHaveBeenCalledTimes(2);
	});
});
