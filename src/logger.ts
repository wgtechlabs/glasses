import { LogEngine, LogMode } from "@wgtechlabs/log-engine";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVEL_TO_MODE: Record<LogLevel, LogMode> = {
	debug: LogMode.DEBUG,
	info: LogMode.INFO,
	warn: LogMode.WARN,
	error: LogMode.ERROR,
};

/** Sets the global log level threshold. Call once at startup with `config.logLevel`. */
export function setLogLevel(level: LogLevel): void {
	LogEngine.configure({ mode: LOG_LEVEL_TO_MODE[level] });
}

/**
 * Thin wrapper over @wgtechlabs/log-engine matching this project's prior
 * `logger.info(msg, data?)` call shape so existing call sites don't churn.
 */
export const logger = {
	debug: (msg: string, data?: unknown) => LogEngine.debug(msg, data),
	info: (msg: string, data?: unknown) => LogEngine.info(msg, data),
	warn: (msg: string, data?: unknown) => LogEngine.warn(msg, data),
	error: (msg: string, data?: unknown) => LogEngine.error(msg, data),
};

setLogLevel((process.env.LOG_LEVEL as LogLevel) || "info");
