import { type IncomingMessage, createServer } from "node:http";
import { TelegramChannel, TelegramMessenger } from "./channels/telegram";
import { loadConfig } from "./config";
import { Database } from "./db";
import { logger, setLogLevel } from "./logger";
import { SandboxManager } from "./sandbox";
import { Scheduler } from "./scheduler";

class RequestPayloadError extends Error {}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > 1_000_000) {
				reject(new RequestPayloadError("Request body too large."));
				req.destroy();
			}
		});
		req.on("end", () => {
			try {
				resolve(body ? (JSON.parse(body) as unknown) : {});
			} catch {
				reject(new RequestPayloadError("Request body is not valid JSON."));
			}
		});
		req.on("error", (error) => reject(new RequestPayloadError(error.message)));
	});
}

async function main(): Promise<void> {
	const config = loadConfig();
	setLogLevel(config.logLevel);
	logger.info("Starting Glasses gateway");

	const db = new Database(config.databaseUrl);
	await db.initialize();
	const sandbox = new SandboxManager(config.railwayApiToken, config.railwayEnvironmentId);
	const messenger = new TelegramMessenger(config.telegramBotToken);
	const scheduler = new Scheduler(db, sandbox, messenger, config);
	const telegram = new TelegramChannel(config.telegramAllowedUserId, db, scheduler, messenger, {
		copilot: Boolean(config.copilotGithubToken),
		devin: Boolean(config.devinCredentialsBase64),
	});
	await scheduler.start();

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);
		if (req.method === "POST" && url.pathname === "/webhook/telegram") {
			const secret = req.headers["x-telegram-bot-api-secret-token"];
			if (typeof secret !== "string" || !messenger.isValidWebhookSecret(secret)) {
				logger.warn("Rejected Telegram webhook with invalid secret");
				res.writeHead(401, { "Content-Type": "application/json" });
				res.end('{"ok":false}');
				return;
			}

			try {
				const payload = await readJsonBody(req);
				await telegram.handleWebhook(payload);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end('{"ok":true}');
			} catch (error) {
				logger.error("Telegram webhook intake failed", {
					reason: error instanceof Error ? error.name : "unknown",
				});
				res.writeHead(error instanceof RequestPayloadError ? 400 : 500, {
					"Content-Type": "application/json",
				});
				res.end('{"ok":false}');
			}
			return;
		}
		if (req.method === "GET" && url.pathname === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end('{"status":"ok"}');
			return;
		}
		res.writeHead(404, { "Content-Type": "text/plain" });
		res.end("Not found");
	});

	server.listen(config.port, async () => {
		logger.info(`Gateway listening on port ${config.port}`);
		try {
			await messenger.registerWebhook(process.env.RAILWAY_PUBLIC_DOMAIN);
		} catch (error) {
			logger.error("Telegram webhook registration failed", {
				reason: error instanceof Error ? error.name : "unknown",
			});
		}
	});

	const shutdown = (): void => {
		scheduler.stop();
		server.close(() => void db.close());
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);
}

void main().catch((error) => {
	logger.error("Fatal startup error", {
		reason: error instanceof Error ? error.name : "unknown",
	});
	process.exit(1);
});
