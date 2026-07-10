import { describe, expect, it } from "bun:test";
import { JsonLineParser, parseRunnerResult } from "../src/runner-protocol";

describe("runner protocol", () => {
	it("parses chunked JSONL events and ignores non-protocol output", () => {
		const parser = new JsonLineParser();
		expect(parser.push('{"type":"lifecycle","stage":"run')).toEqual([]);
		expect(
			parser.push(
				'ning"}\nnot-json\n{"type":"tool","stage":"started","name":"edit"}\n{"type":"text_delta","content":"Hi"}\n',
			),
		).toEqual([
			{ type: "lifecycle", stage: "running" },
			{ type: "tool", stage: "started", name: "edit" },
			{ type: "text_delta", content: "Hi" },
		]);
	});

	it("validates structured results and delegations", () => {
		const result = parseRunnerResult({
			version: 1,
			ok: true,
			output: "queued",
			sessionId: "session-1",
			delegations: [{ repository: "wgtechlabs/glasses", task: "Fix tests" }],
			error: null,
			recreatedSession: false,
		});
		expect(result.delegations[0]?.repository).toBe("wgtechlabs/glasses");
		expect(() =>
			parseRunnerResult({
				...result,
				delegations: [{ repository: "owner/repo;env", task: "bad" }],
			}),
		).toThrow(/invalid delegation/);
	});
});
