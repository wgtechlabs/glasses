import { createServer } from "node:http";
import { AgentRegistry } from "./agents/registry";
import { TelegramChannel } from "./channels/telegram";
import { loadConfig } from "./config";
import { Database } from "./db";
import { logger } from "./logger";
import { SandboxManager } from "./sandbox";

function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}

async function main(): Promise<void> {
	logger.info("👓 Starting Glasses gateway");

	const config = loadConfig();
	const db = new Database(config.databaseUrl);
	await db.initialize();

	const sandbox = new SandboxManager(config.railwayApiToken, config.railwayEnvironmentId);
	const agents = new AgentRegistry(sandbox);
	const telegram = new TelegramChannel(
		config.telegramBotToken,
		config.telegramAllowedUserId,
		db,
		agents,
		sandbox,
	);

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

		if (req.method === "POST" && url.pathname === "/webhook/telegram") {
			try {
				const payload = await readJsonBody(req);
				await telegram.handleWebhook(payload);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (error) {
				logger.error("Telegram webhook error", error);
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ ok: false }));
			}
			return;
		}

		if (req.method === "GET" && url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
			return;
		}

		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found");
	});

	server.listen(config.port, () => {
		logger.info(`Gateway listening on port ${config.port}`);
	});
}

main().catch((error) => {
	logger.error("Fatal startup error", error);
	process.exit(1);
});
