import { describe, expect, it } from "bun:test";
import { isNodeBinaryPath, isResultFileNotFound } from "../src/sandbox";

describe("isResultFileNotFound", () => {
	it("treats missing-file signals as the transient not-found condition", () => {
		for (const message of [
			"ENOENT: no such file or directory",
			"open /glasses/result.json: no such file or directory",
			"file not found",
			"path /glasses/result.json does not exist",
		]) {
			expect(isResultFileNotFound(new Error(message))).toBe(true);
		}
	});

	it("does not treat real failures as a missing file", () => {
		for (const message of [
			"Runner result has an invalid shape.",
			"Runner result is not an object.",
			"Unexpected error while reading result",
			"EACCES: permission denied, open '/glasses/result.json'",
			"Unexpected token < in JSON at position 0",
		]) {
			expect(isResultFileNotFound(new Error(message))).toBe(false);
		}
	});
});

describe("isNodeBinaryPath", () => {
	it("accepts genuine Node binary paths", () => {
		for (const execPath of [
			"/usr/local/bin/node",
			"/usr/bin/node",
			"/home/runner/.nvm/versions/node/v22.20.1/bin/node",
			"node",
		]) {
			expect(isNodeBinaryPath(execPath)).toBe(true);
		}
	});

	it("rejects non-Node runtimes such as Bun", () => {
		for (const execPath of [
			"/usr/local/bin/bun",
			"/home/runner/.bun/bin/bun",
			"/usr/bin/deno",
			"/usr/local/bin/ts-node",
		]) {
			expect(isNodeBinaryPath(execPath)).toBe(false);
		}
	});
});
