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
		});
		expect(scheduler.kick).toHaveBeenCalled();
		expect(sent).toEqual([]);
	});

	it("keeps /new as a compatibility message", async () => {
		const { channel, db, sent } = setup();
		await channel.handleWebhook(payload("/new owner/repo"));
		expect(db.enqueueTelegramTurn).not.toHaveBeenCalled();
		expect(sent[0]).toContain("No /new");
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
