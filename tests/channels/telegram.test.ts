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
});
