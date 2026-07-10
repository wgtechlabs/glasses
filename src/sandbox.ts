import { Sandbox } from "railway";
import { logger } from "./logger";

export interface SandboxCreateOptions {
	idleTimeoutMinutes?: number;
	privateNetwork?: boolean;
	env?: Record<string, string>;
}

/**
 * Wraps the Railway Sandbox SDK for the gateway's needs: create a sandbox,
 * run a command in it, and destroy it. One conversation maps to one
 * sandbox, reused across messages via its id.
 */
export class SandboxManager {
	constructor(
		private railwayToken: string,
		private railwayEnvironmentId: string,
	) {}

	async create(options: SandboxCreateOptions = {}): Promise<string> {
		const sandbox = await Sandbox.create({
			token: this.railwayToken,
			environmentId: this.railwayEnvironmentId,
			idleTimeoutMinutes: options.idleTimeoutMinutes ?? 60,
			networkIsolation: options.privateNetwork ? "PRIVATE" : "ISOLATED",
			env: {
				...(process.env.COPILOT_GITHUB_TOKEN
					? { COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN }
					: {}),
				...options.env,
			},
		});

		logger.info("Sandbox created", { sandboxId: sandbox.id });
		return sandbox.id;
	}

	/**
	 * Runs a command to completion in an existing sandbox and returns its
	 * stdout. Non-zero exits throw so callers cannot mistake failures for
	 * successful agent output.
	 */
	async exec(sandboxId: string, command: string, timeoutSec = 300): Promise<string> {
		const sandbox = await Sandbox.connect(sandboxId, {
			token: this.railwayToken,
			environmentId: this.railwayEnvironmentId,
		});

		const result = await sandbox.exec(command, { timeoutSec });

		if (result.exitCode !== 0) {
			logger.warn("Sandbox command exited non-zero", {
				sandboxId,
				exitCode: result.exitCode,
			});
			const output = result.stderr || result.stdout || "No command output";
			throw new Error(`Command failed with exit code ${result.exitCode}: ${output}`);
		}

		return result.stdout;
	}

	async destroy(sandboxId: string): Promise<void> {
		const sandbox = await Sandbox.connect(sandboxId, {
			token: this.railwayToken,
			environmentId: this.railwayEnvironmentId,
		});
		await sandbox.destroy();
		logger.info("Sandbox destroyed", { sandboxId });
	}
}
