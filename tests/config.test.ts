import { describe, it, expect } from "bun:test";
import { loadConfig } from "../src/config";

const validEnv = {
  RAILWAY_API_TOKEN: "rw_token",
  RAILWAY_ENVIRONMENT_ID: "env_123",
  DATABASE_URL: "postgresql://localhost/glasses",
  TELEGRAM_BOT_TOKEN: "bot_token",
  TELEGRAM_ALLOWED_USER_ID: "123456789",
};

describe("loadConfig", () => {
  it("loads valid config with defaults applied", () => {
    const config = loadConfig(validEnv as NodeJS.ProcessEnv);

    expect(config.railwayApiToken).toBe("rw_token");
    expect(config.telegramAllowedUserId).toBe("123456789");
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe("info");
  });

  it("respects PORT and LOG_LEVEL overrides", () => {
    const config = loadConfig({
      ...validEnv,
      PORT: "8080",
      LOG_LEVEL: "debug",
    } as NodeJS.ProcessEnv);

    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("debug");
  });

  it("throws a descriptive error when a required variable is missing", () => {
    const { TELEGRAM_BOT_TOKEN, ...incomplete } = validEnv;

    expect(() => loadConfig(incomplete as NodeJS.ProcessEnv)).toThrow(
      /telegramBotToken/
    );
  });
});
