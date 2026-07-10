type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  constructor(private level: LogLevel = "info") {}

  private enabled(target: LogLevel): boolean {
    return LEVEL_ORDER[target] >= LEVEL_ORDER[this.level];
  }

  debug(msg: string, data?: unknown): void {
    if (this.enabled("debug")) console.log(`[DEBUG] ${msg}`, data ?? "");
  }

  info(msg: string, data?: unknown): void {
    if (this.enabled("info")) console.log(`[INFO] ${msg}`, data ?? "");
  }

  warn(msg: string, data?: unknown): void {
    if (this.enabled("warn")) console.warn(`[WARN] ${msg}`, data ?? "");
  }

  error(msg: string, data?: unknown): void {
    if (this.enabled("error")) console.error(`[ERROR] ${msg}`, data ?? "");
  }
}

export const logger = new Logger(
  (process.env.LOG_LEVEL as LogLevel) || "info"
);
