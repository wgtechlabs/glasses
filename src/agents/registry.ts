import type { SandboxManager } from "../sandbox";
import { CopilotAgent } from "./copilot";
import { DevinAgent } from "./devin";
import type { AgentLike } from "./types";

/**
 * Looks up agent wrappers by name. New CLIs register here and nowhere
 * else — channels and the gateway only ever talk to `AgentLike`.
 */
export class AgentRegistry {
	private agents = new Map<string, AgentLike>();

	constructor(sandbox: SandboxManager) {
		this.agents.set("copilot", new CopilotAgent(sandbox));
		this.agents.set("devin", new DevinAgent());
	}

	get(name: string): AgentLike | undefined {
		return this.agents.get(name);
	}

	names(): string[] {
		return Array.from(this.agents.keys());
	}
}
