import { describe, expect, it, mock } from "bun:test";
import { CopilotAgent } from "../../src/agents/copilot";
import type { SandboxManager } from "../../src/sandbox";

function fakeSandbox(execImpl: (sandboxId: string, command: string) => Promise<string>) {
	return {
		create: mock(async () => "sbx_fake"),
		exec: mock(execImpl),
		destroy: mock(async () => {}),
	} as unknown as SandboxManager;
}

describe("CopilotAgent", () => {
	it("clones the repository only when it isn't already present", async () => {
		const commands: string[] = [];
		const sandbox = fakeSandbox(async (_id, command) => {
			commands.push(command);
			return "";
		});

		const agent = new CopilotAgent(sandbox);
		await agent.ensureReady("sbx_1", "wgtechlabs/glasses");

		expect(commands).toHaveLength(1);
		expect(commands[0]).toContain("git clone");
		expect(commands[0]).toContain("wgtechlabs/glasses");
		expect(commands[0]).toContain("/workspace/glasses");
	});

	it("sends a prompt through the copilot CLI in non-interactive mode", async () => {
		const commands: string[] = [];
		const sandbox = fakeSandbox(async (_id, command) => {
			commands.push(command);
			return "42";
		});

		const agent = new CopilotAgent(sandbox);
		const result = await agent.send({
			sandboxId: "sbx_1",
			repository: "wgtechlabs/glasses",
			repositoryPath: "/workspace/glasses",
			prompt: "what is 6 * 7?",
			conversationSessionId: null,
		});

		expect(result.succeeded).toBe(true);
		expect(result.output).toBe("42");
		expect(commands[0]).toContain('copilot -p "what is 6 * 7?"');
		expect(commands[0]).toContain("-s");
		expect(commands[0]).not.toContain("--resume");
	});

	it("resumes the CLI session when a conversation session id is present", async () => {
		const commands: string[] = [];
		const sandbox = fakeSandbox(async (_id, command) => {
			commands.push(command);
			return "ok";
		});

		const agent = new CopilotAgent(sandbox);
		await agent.send({
			sandboxId: "sbx_1",
			repository: "wgtechlabs/glasses",
			repositoryPath: "/workspace/glasses",
			prompt: "continue",
			conversationSessionId: "session-abc",
		});

		expect(commands[0]).toContain('--resume "session-abc"');
	});

	it("returns a failed result instead of throwing when the sandbox command errors", async () => {
		const sandbox = fakeSandbox(async () => {
			throw new Error("sandbox unreachable");
		});

		const agent = new CopilotAgent(sandbox);
		const result = await agent.send({
			sandboxId: "sbx_1",
			repository: "wgtechlabs/glasses",
			repositoryPath: "/workspace/glasses",
			prompt: "hello",
			conversationSessionId: null,
		});

		expect(result.succeeded).toBe(false);
		expect(result.output).toContain("sandbox unreachable");
	});
});
