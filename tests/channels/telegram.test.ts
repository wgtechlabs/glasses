import { describe, expect, it, mock } from "bun:test";
import { TelegramMessenger } from "../../src/channels/telegram";

describe("TelegramMessenger", () => {
	it("registers a protected webhook and current commands", async () => {
		const originalFetch = globalThis.fetch;
		const fetchMock = mock(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		try {
			const messenger = new TelegramMessenger("bot_token");
			await messenger.registerWebhook("glasses-production.up.railway.app");

			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.telegram.org/botbot_token/setWebhook");
			const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
			expect(body).toEqual({
				url: "https://glasses-production.up.railway.app/webhook/telegram",
				secret_token: expect.stringMatching(/^[a-f0-9]{64}$/),
			});
			expect(messenger.isValidWebhookSecret(body.secret_token)).toBe(true);
			expect(messenger.isValidWebhookSecret("wrong")).toBe(false);
			expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
				commands: expect.arrayContaining([
					{ command: "instructions", description: "Show or update global instructions" },
				]),
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("keeps Telegram's typing indicator active while work runs", async () => {
		const originalFetch = globalThis.fetch;
		const fetchMock = mock(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		try {
			const messenger = new TelegramMessenger("bot_token");
			const stopTyping = messenger.startTyping("123");
			await new Promise<void>((resolve) => setImmediate(resolve));
			stopTyping();

			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				"https://api.telegram.org/botbot_token/sendChatAction",
			);
			expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
				chat_id: "123",
				action: "typing",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
