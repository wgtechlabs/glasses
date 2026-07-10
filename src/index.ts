import { loadConfig } from "./config";
import { Database } from "./db";
import { SandboxManager } from "./sandbox";
import { AgentRegistry } from "./agents/registry";
import { TelegramChannel } from "./channels/telegram";
import { logger } from "./logger";

async function main(): Promise<void> {
  logger.info("Starting Glasses gateway");

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
    sandbox
  );

  Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "POST" && url.pathname === "/webhook/telegram") {
        try {
          const payload = await req.json();
          await telegram.handleWebhook(payload);
          return Response.json({ ok: true });
        } catch (error) {
          logger.error("Telegram webhook error", error);
          return Response.json({ ok: false }, { status: 500 });
        }
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  logger.info(`Gateway listening on port ${config.port}`);
}

main().catch((error) => {
  logger.error("Fatal startup error", error);
  process.exit(1);
});
