import { logger } from "../logger";
import type { AgentLike, AgentSendInput, AgentSendResult } from "./types";

/**
 * Skeleton wrapper for Devin CLI. Not wired into a working conversation
 * flow yet — the registry exposes it so the channel/agent contracts are
 * already in place, but `send()` reports failure until the real
 * implementation lands.
 *
 * ponytail: implement using `devin -p "<prompt>"` for single-turn calls
 * and `devin -r <id>` to resume, mirroring the copilot wrapper's shape.
 * Add when Devin CLI support is prioritized.
 */
export class DevinAgent implements AgentLike {
	readonly name = "devin";

	async ensureReady(sandboxId: string, repository: string): Promise<void> {
		logger.debug("DevinAgent.ensureReady is a no-op placeholder", {
			sandboxId,
			repository,
		});
	}

	async send(input: AgentSendInput): Promise<AgentSendResult> {
		logger.warn("Devin CLI support is not implemented yet");
		return {
			output: "Devin CLI support is coming soon — Copilot is available today.",
			sessionId: input.conversationSessionId,
			succeeded: false,
		};
	}
}
