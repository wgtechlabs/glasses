import { logger } from "../logger";
import type { SandboxManager } from "../sandbox";
import { repositoryPath } from "./paths";
import type { AgentLike, AgentSendInput, AgentSendResult } from "./types";

/**
 * Wraps GitHub Copilot CLI. Preserves the CLI's real behavior instead of
 * reimplementing it: repository cloning happens once per sandbox, prompts
 * are sent through `copilot -p` in non-interactive mode, and turns are
 * chained via `--resume` so a chat conversation reads like one continuous
 * CLI session rather than isolated one-shot calls.
 *
 * Auth: relies on the sandbox already being signed in (via `gh auth login`
 * or `COPILOT_GITHUB_TOKEN` baked into the sandbox environment at create
 * time). This wrapper does not manage credentials.
 */
export class CopilotAgent implements AgentLike {
	readonly name = "copilot";

	constructor(private sandbox: SandboxManager) {}

	async ensureReady(sandboxId: string, repository: string): Promise<void> {
		const repoPath = repositoryPath(repository);
		await this.sandbox.exec(
			sandboxId,
			`(command -v copilot >/dev/null 2>&1 || npm install -g @github/copilot) && ([ -d "${repoPath}/.git" ] || git clone --depth 1 "https://github.com/${repository}.git" "${repoPath}")`,
		);
	}

	async send(input: AgentSendInput): Promise<AgentSendResult> {
		const escapedPrompt = input.prompt.replace(/"/g, '\\"');
		const resumeFlag = input.conversationSessionId
			? `--resume "${input.conversationSessionId}" `
			: "";

		const command = `cd "${input.repositoryPath}" && copilot -p "${escapedPrompt}" ${resumeFlag}-s --allow-all-tools --no-ask-user`;

		try {
			const output = await this.sandbox.exec(input.sandboxId, command);
			logger.info("Copilot turn completed", { repository: input.repository });

			return {
				output: output.trim(),
				// ponytail: copilot CLI doesn't print a stable session id to stdout in -s mode;
				// reuse the conversation id as the --resume key once CLI exposes one, add real
				// extraction here if `copilot --share` output starts including it.
				sessionId: input.conversationSessionId,
				succeeded: true,
			};
		} catch (error) {
			logger.error("Copilot turn failed", error);
			return {
				output: `Copilot CLI error: ${error instanceof Error ? error.message : String(error)}`,
				sessionId: input.conversationSessionId,
				succeeded: false,
			};
		}
	}
}
