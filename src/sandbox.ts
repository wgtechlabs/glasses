import { createReadStream, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

export class SandboxManager {
	private readonly runnerPath: string;

	constructor(
		private railwayToken: string,
		private railwayEnvironmentId: string,
		runnerPath?: string,
	) {
		this.runnerPath = runnerPath ?? fileURLToPath(new URL("../dist/runner.js", import.meta.url));
	}

	async createMain(authToken: string, idleTimeoutMinutes: number): Promise<string> {
		return this.create(authToken, idleTimeoutMinutes);
	}

	async createWorker(authToken: string): Promise<string> {
		return this.create(authToken, 60);
	}

	private async create(authToken: string, idleTimeoutMinutes: number): Promise<string> {
		const sandbox = await Sandbox.create({
			token: this.railwayToken,
			environmentId: this.railwayEnvironmentId,
			idleTimeoutMinutes,
			networkIsolation: "ISOLATED",
			env: {
				COPILOT_GITHUB_TOKEN: authToken,
				GH_TOKEN: authToken,
				COPILOT_AUTO_UPDATE: "false",
				COPILOT_CLI_PATH: "/glasses/copilot-cli",
				GLASSES_GH_CLI_PATH: "/glasses/gh",
			},
		});
		logger.info("Sandbox created", { sandboxId: sandbox.id });
		return sandbox.id;
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
		const runner = await readFile(this.runnerPath);
		if (await sandbox.files.exists("/glasses/result.json")) {
			await sandbox.files.remove("/glasses/result.json");
		}
		const writes: Promise<void>[] = [
			sandbox.files.write("/glasses/runner.js", runner, { mode: 0o755 }),
			sandbox.files.write("/glasses/input.json", JSON.stringify(input), { mode: 0o600 }),
		];
		if (!(await sandbox.files.exists("/glasses/copilot-cli"))) {
			const copilotCli = this.findCopilotBinary();
			writes.push(
				sandbox.files.write("/glasses/copilot-cli", () => createReadStream(copilotCli), {
					mode: 0o755,
				}),
			);
		}
		if (input.mode === "worker" && !(await sandbox.files.exists("/glasses/gh"))) {
			const ghCli = this.findGhBinary();
			writes.push(
				sandbox.files.write("/glasses/gh", () => createReadStream(ghCli), {
					mode: 0o755,
				}),
			);
		}
		await Promise.all(writes);

		const parser = new JsonLineParser();
		const handle = sandbox.exec(
			"node /glasses/runner.js /glasses/input.json /glasses/result.json",
			{
				timeoutSec,
				onStdout: (chunk) => this.dispatchEvents(parser.push(chunk), callbacks),
				// Runner/CLI stderr can contain repository data. It is intentionally not logged.
				onStderr: () => undefined,
			},
		);
		const sessionName = await handle.sessionName;
		await callbacks.onExecSession?.(sessionName);
		const outcome = await handle;
		this.dispatchEvents(parser.finish(), callbacks);
		if (outcome.timedOut) throw new Error("Sandbox runner timed out.");
		return this.readResult(sandbox);
	}

	async reattachRunner(
		sandboxId: string,
		sessionName: string,
		timeoutSec: number,
		callbacks: RunnerCallbacks = {},
	): Promise<RunnerResult> {
		const sandbox = await this.connect(sandboxId);
		const parser = new JsonLineParser();
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
		return this.readResult(sandbox);
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

	private findGhBinary(): string {
		const configured = process.env.GLASSES_GH_CLI_PATH;
		if (configured && existsSync(configured)) return configured;
		for (const candidate of ["/usr/bin/gh", "/usr/local/bin/gh"]) {
			if (existsSync(candidate)) return candidate;
		}
		throw new Error("GitHub CLI is unavailable. Set GLASSES_GH_CLI_PATH explicitly.");
	}
}
