import { describe, expect, it, mock } from "bun:test";
import type { AgentRegistry } from "../../src/agents/registry";
import { TelegramChannel } from "../../src/channels/telegram";
import type { Database } from "../../src/db";
import type { SandboxManager } from "../../src/sandbox";

describe("TelegramChannel", () => {
	it("registers the Railway domain as its webhook", async () => {
		const originalFetch = globalThis.fetch;
		const fetchMock = mock(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		try {
			const telegram = new TelegramChannel(
				"bot_token",
				"123456789",
				{} as Database,
				{} as AgentRegistry,
				{} as SandboxManager,
			);

			await telegram.registerWebhook("glasses-production.up.railway.app");

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botbot_token/setWebhook");
			const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
			expect(body).toEqual({
				url: "https://glasses-production.up.railway.app/webhook/telegram",
				secret_token: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			expect(telegram.isValidWebhookSecret(body.secret_token)).toBe(true);
			expect(telegram.isValidWebhookSecret("wrong")).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("deletes the active sandbox session", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async () => new Response(null, { status: 200 })) as typeof fetch;
		const conversation = {
			id: "conv_1",
			channel: "telegram" as const,
			userId: "123456789",
			agent: "copilot" as const,
			repository: "wgtechlabs/glasses",
			sandboxId: "sbx_1",
			sessionId: "session_1",
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		const db = {
			getLatestConversationForUser: mock(async () => conversation),
			saveConversation: mock(async () => {}),
		} as unknown as Database;
		const sandbox = {
			destroy: mock(async () => {}),
		} as unknown as SandboxManager;

		try {
			const telegram = new TelegramChannel(
				"bot_token",
				"123456789",
				db,
				{} as AgentRegistry,
				sandbox,
			);
			await telegram.handleWebhook({
				message: {
					message_id: 1,
					from: { id: 123456789 },
					chat: { id: 123456789 },
					text: "/delete",
				},
			});

			expect(sandbox.destroy).toHaveBeenCalledWith("sbx_1");
			expect(db.saveConversation).toHaveBeenCalledWith(
				expect.objectContaining({ sandboxId: null, sessionId: null }),
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
