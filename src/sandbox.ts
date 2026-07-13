import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "railway";
import { logger } from "./logger";
import {
	JsonLineParser,
	type RunnerEvent,
	type RunnerInput,
	type RunnerResult,
	parseRunnerResult,
} from "./runner-protocol";

export interface RunnerCallbacks {
	onExecSession?: (sessionName: string) => Promise<void> | void;
	onEvent?: (event: RunnerEvent) => Promise<void> | void;
}

const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;

export class SandboxManager {
	private readonly runnerPath: string;
	private runnerBundle: Buffer | null = null;

	constructor(
		private railwayToken: string,
		private railwayEnvironmentId: string,
		runnerPath?: string,
	) {
		this.runnerPath = runnerPath ?? fileURLToPath(new URL("../dist/runner.js", import.meta.url));
	}

	async createMain(authToken?: string): Promise<string> {
		return this.create(authToken, 25);
	}

	async createWorker(authToken: string): Promise<string> {
		return this.create(authToken, 15);
	}

	async restoreWorker(authToken: string, checkpointName: string): Promise<string> {
		return this.create(authToken, 15, checkpointName);
	}

	private async create(
		authToken: string | undefined,
		idleTimeoutMinutes: number,
		checkpointName?: string,
	): Promise<string> {
		const options = {
			token: this.railwayToken,
			environmentId: this.railwayEnvironmentId,
			idleTimeoutMinutes,
			networkIsolation: "ISOLATED" as const,
			env: {
				...(authToken
					? {
							COPILOT_GITHUB_TOKEN: authToken,
							GH_TOKEN: authToken,
						}
					: {}),
				...(process.env.DEVIN_CREDENTIALS_BASE64
					? { DEVIN_CREDENTIALS_BASE64: process.env.DEVIN_CREDENTIALS_BASE64 }
					: {}),
				COPILOT_AUTO_UPDATE: "false",
				COPILOT_CLI_PATH: "/glasses/copilot-cli",
			},
		};
		const sandbox = checkpointName
			? await Sandbox.create(checkpointName, options)
			: await Sandbox.create(options);
		logger.info("Sandbox created", { sandboxId: sandbox.id });
		return sandbox.id;
	}

	async checkpoint(sandboxId: string, name: string): Promise<string> {
		const existing = await this.findCheckpoint(name);
		if (existing) return existing.key;
		const checkpoint = await (await this.connect(sandboxId)).checkpoint(name);
		logger.info("Sandbox checkpoint created", { sandboxId, checkpoint: checkpoint.key });
		return checkpoint.key;
	}

	async deleteCheckpoint(name: string): Promise<void> {
		const options = { token: this.railwayToken, environmentId: this.railwayEnvironmentId };
		const checkpoint = await this.findCheckpoint(name);
		if (checkpoint) await Sandbox.deleteCheckpoint(checkpoint.id, options);
	}

	private async findCheckpoint(name: string) {
		return (
			await Sandbox.checkpoints({
				token: this.railwayToken,
				environmentId: this.railwayEnvironmentId,
			})
		).find((item) => item.key === name);
	}

	async isAlive(sandboxId: string): Promise<boolean> {
		try {
			const sandbox = await this.connect(sandboxId);
			await sandbox.refresh();
			return sandbox.status === "RUNNING";
		} catch {
			return false;
		}
	}

	async runRunner(
		sandboxId: string,
		input: RunnerInput,
		timeoutSec: number,
		callbacks: RunnerCallbacks = {},
	): Promise<RunnerResult> {
		const sandbox = await this.connect(sandboxId);
		const keepAlive = this.startKeepAlive(sandbox, sandboxId);
		const runner = await this.loadRunnerBundle();
		const [hasResult, hasCopilotCli, hasNodeBinary] = await Promise.all([
			sandbox.files.exists("/glasses/result.json"),
			sandbox.files.exists("/glasses/copilot-cli"),
			sandbox.files.exists("/glasses/node"),
		]);
		if (hasResult) {
			await sandbox.files.remove("/glasses/result.json");
		}
		const writes: Promise<void>[] = [
			sandbox.files.write("/glasses/runner.js", runner, { mode: 0o755 }),
			sandbox.files.write("/glasses/input.json", JSON.stringify(input), { mode: 0o600 }),
		];
		if (!hasCopilotCli) {
			const copilotCli = this.findCopilotBinary();
			writes.push(
				sandbox.files.write("/glasses/copilot-cli", () => createReadStream(copilotCli), {
					mode: 0o755,
				}),
			);
		}
		if (!hasNodeBinary) {
			const nodeBinary = this.findNodeBinary();
			writes.push(
				sandbox.files.write("/glasses/node", () => createReadStream(nodeBinary), {
					mode: 0o755,
				}),
			);
		}
		await Promise.all(writes);

		const parser = new JsonLineParser();
		const handle = sandbox.exec(
			"/glasses/node /glasses/runner.js /glasses/input.json /glasses/result.json",
			{
				timeoutSec,
				onStdout: (chunk) => this.dispatchEvents(parser.push(chunk), callbacks),
				// Runner/CLI stderr can contain repository data. It is intentionally not logged.
				onStderr: () => undefined,
			},
		);
		const sessionName = await handle.sessionName;
		await callbacks.onExecSession?.(sessionName);
		try {
			const outcome = await handle;
			this.dispatchEvents(parser.finish(), callbacks);
			if (outcome.timedOut) throw new Error("Sandbox runner timed out.");
			if (outcome.exitCode !== 0) {
				throw new Error(`Sandbox runner exited with code ${outcome.exitCode}.`);
			}
			return this.readResultWithRetry(sandbox);
		} finally {
			clearInterval(keepAlive);
		}
	}

	async reattachRunner(
		sandboxId: string,
		sessionName: string,
		timeoutSec: number,
		callbacks: RunnerCallbacks = {},
	): Promise<RunnerResult> {
		const sandbox = await this.connect(sandboxId);
		const keepAlive = this.startKeepAlive(sandbox, sandboxId);
		const parser = new JsonLineParser();
		try {
			const outcome = await sandbox.exec(
				{ sessionName },
				{
					timeoutSec,
					onStdout: (chunk) => this.dispatchEvents(parser.push(chunk), callbacks),
					onStderr: () => undefined,
				},
			);
			this.dispatchEvents(parser.finish(), callbacks);
			if (outcome.timedOut) throw new Error("Reattached sandbox runner timed out.");
			if (outcome.exitCode !== 0) {
				throw new Error(`Reattached sandbox runner exited with code ${outcome.exitCode}.`);
			}
			return this.readResultWithRetry(sandbox);
		} finally {
			clearInterval(keepAlive);
		}
	}

	async destroy(sandboxId: string): Promise<void> {
		try {
			const sandbox = await this.connect(sandboxId);
			await sandbox.destroy();
			logger.info("Sandbox destroyed", { sandboxId });
		} catch (error) {
			logger.warn("Sandbox destroy did not complete", {
				sandboxId,
				reason: error instanceof Error ? error.name : "unknown",
			});
		}
	}

	private connect(sandboxId: string): Promise<Sandbox> {
		return Sandbox.connect(sandboxId, {
			token: this.railwayToken,
			environmentId: this.railwayEnvironmentId,
		});
	}

	private async readResult(sandbox: Sandbox): Promise<RunnerResult> {
		const raw = await sandbox.files.read("/glasses/result.json");
		return parseRunnerResult(Buffer.from(raw).toString("utf8"));
	}

	private async readResultWithRetry(sandbox: Sandbox): Promise<RunnerResult> {
		const maxAttempts = 3;
		let lastError: Error | undefined;
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
			try {
				return await this.readResult(sandbox);
			} catch (error) {
				// Only a not-yet-visible result file is transient. Parse errors,
				// permission errors, and everything else are real failures we surface
				// immediately instead of masking them behind retries.
				if (!(error instanceof Error) || !isResultFileNotFound(error)) throw error;
				lastError = error;
				if (attempt < maxAttempts - 1) {
					await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
				}
			}
		}
		throw lastError ?? new Error("Worker runner result was not produced.");
	}

	private dispatchEvents(events: RunnerEvent[], callbacks: RunnerCallbacks): void {
		for (const event of events) {
			void Promise.resolve()
				.then(() => callbacks.onEvent?.(event))
				.catch((error) => {
					logger.warn("Runner event callback failed", {
						reason: error instanceof Error ? error.name : "unknown",
					});
				});
		}
	}

	private startKeepAlive(sandbox: Sandbox, sandboxId: string): NodeJS.Timeout {
		const timer = setInterval(() => {
			void sandbox.refresh().catch((error) => {
				logger.warn("Sandbox keepalive refresh failed", {
					sandboxId,
					reason: error instanceof Error ? error.name : "unknown",
				});
			});
		}, KEEPALIVE_INTERVAL_MS);
		timer.unref();
		return timer;
	}

	private async loadRunnerBundle(): Promise<Buffer> {
		if (this.runnerBundle) return this.runnerBundle;
		this.runnerBundle = await readFile(this.runnerPath);
		return this.runnerBundle;
	}

	private findCopilotBinary(): string {
		const configured = process.env.GLASSES_COPILOT_CLI_PATH;
		if (configured && existsSync(configured)) return configured;
		const require = createRequire(import.meta.url);
		const arch = process.arch === "arm64" ? "arm64" : "x64";
		for (const platform of ["linux", "linuxmusl"]) {
			try {
				const entry = require.resolve(`@github/copilot-${platform}-${arch}`);
				const binary = join(dirname(entry), "copilot");
				if (existsSync(binary)) return binary;
			} catch {
				// Optional dependencies are platform-specific; try the next Linux variant.
			}
		}
		throw new Error(
			"Linux Copilot CLI package is unavailable. Set GLASSES_COPILOT_CLI_PATH explicitly.",
		);
	}

	private findNodeBinary(): string {
		const configured = process.env.GLASSES_NODE_PATH;
		if (configured && existsSync(configured)) return configured;
		// Reuse the current runtime only when it is genuinely Node. Under Bun
		// (the dev/test scripts) process.execPath points at the Bun binary, and
		// shipping that into the sandbox as /glasses/node would run the runner on
		// Bun instead of Node, defeating the point of an explicit Node runtime.
		if (isNodeBinaryPath(process.execPath) && existsSync(process.execPath)) {
			return process.execPath;
		}
		for (const candidate of ["/usr/local/bin/node", "/usr/bin/node"]) {
			if (existsSync(candidate)) return candidate;
		}
		throw new Error("Node.js binary is unavailable. Set GLASSES_NODE_PATH explicitly.");
	}
}

/**
 * Reports whether a result read failed only because `/glasses/result.json` was
 * not visible yet, the transient file-visibility lag we retry through. Matching
 * is restricted to not-found signals so genuine failures (invalid result shape,
 * permission errors, and other read errors) are never mistaken for a missing
 * file and are surfaced without needless retries.
 */
export function isResultFileNotFound(error: Error): boolean {
	return /enoent|not found|no such file|does not exist/i.test(error.message);
}

/**
 * Reports whether `execPath` points at a Node.js binary. `process.execPath`
 * only names `node` when this process actually runs under Node; under Bun (the
 * `dev`/`test` scripts) or another runtime it names that runtime's binary
 * (e.g. `bun`), which must never be uploaded into the sandbox as the Node
 * runtime. Matching on the executable name keeps the check runtime-agnostic.
 */
export function isNodeBinaryPath(execPath: string): boolean {
	return basename(execPath) === "node";
}
