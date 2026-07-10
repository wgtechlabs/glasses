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

	it("streams generated text through Telegram drafts", async () => {
		const originalFetch = globalThis.fetch;
		const fetchMock = mock(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		try {
			const messenger = new TelegramMessenger("bot_token");
			const stream = messenger.startStreaming("123");
			stream.update("**Hello** `world`");
			await new Promise<void>((resolve) => setImmediate(resolve));
			stream.stop();

			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				"https://api.telegram.org/botbot_token/sendMessageDraft",
			);
			const initial = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
			const update = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
			expect(initial).toEqual({
				chat_id: "123",
				draft_id: expect.any(Number),
				text: "",
				parse_mode: "HTML",
			});
			expect(update).toEqual({
				chat_id: "123",
				draft_id: initial.draft_id,
				text: "<b>Hello</b> <code>world</code>",
				parse_mode: "HTML",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("formats final replies for Telegram", async () => {
		const originalFetch = globalThis.fetch;
		const fetchMock = mock(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchMock as typeof fetch;

		try {
			await new TelegramMessenger("bot_token").send(
				"123",
				'# Result\n- **Ready** & <safe>\n- [Docs](https://example.com/?q="x")\n\n```ts\nconst ok = true;\n```',
			);

			expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
				chat_id: "123",
				text: '<b>Result</b>\n• <b>Ready</b> &amp; &lt;safe&gt;\n• <a href="https://example.com/?q=&quot;x&quot;">Docs</a>\n\n<pre>const ok = true;\n</pre>',
				parse_mode: "HTML",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
