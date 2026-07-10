import { describe, expect, it } from "bun:test";
import { isValidRepository, repositoryPath } from "../src/repository";

describe("repository validation", () => {
	it("accepts strict owner/repository identifiers", () => {
		expect(isValidRepository("wgtechlabs/glasses")).toBe(true);
		expect(repositoryPath("wgtechlabs/glasses")).toBe("/workspace/wgtechlabs--glasses");
	});

	it("rejects URLs, refs, paths, and shell metacharacters", () => {
		for (const value of [
			"https://github.com/wgtechlabs/glasses",
			"wgtechlabs/glasses.git main",
			"wgtechlabs/glasses;env",
			"wgtechlabs/glasses/extra",
			"../glasses",
			"-owner/repo",
		]) {
			expect(isValidRepository(value)).toBe(false);
		}
	});
});
