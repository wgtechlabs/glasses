import { isValidRepository } from "./repository";

export interface TranscriptEntry {
	role: "user" | "assistant" | "system";
	content: string;
}

export interface WorkerSummary {
	repository: string;
	status: "done" | "failed";
	summary: string;
}

export interface RunnerInput {
	version: 1;
	mode: "main" | "worker";
	prompt: string;
	globalInstructions: string;
	sessionId: string | null;
	rehydrate: boolean;
	transcript: TranscriptEntry[];
	workerSummaries: WorkerSummary[];
	repository?: string;
	workerBranch?: string;
	deliveryOnly?: boolean;
}

export interface Delegation {
	repository: string;
	task: string;
}

export interface WorkerDelivery {
	status: "not_needed" | "pushed" | "failed";
	branch: string | null;
	commit: string | null;
	error: string | null;
}

export interface RunnerResult {
	version: 1;
	ok: boolean;
	output: string;
	sessionId: string | null;
	delegations: Delegation[];
	error: string | null;
	recreatedSession: boolean;
	delivery: WorkerDelivery | null;
}

export type RunnerEvent =
	| { type: "lifecycle"; stage: "started" | "cloning" | "running" | "completed" | "failed" }
	| { type: "tool"; stage: "started" | "completed"; name: string }
	| { type: "text_delta"; content: string };

export function parseRunnerEvent(line: string): RunnerEvent | null {
	try {
		const value = JSON.parse(line) as Record<string, unknown>;
		if (
			value.type === "lifecycle" &&
			["started", "cloning", "running", "completed", "failed"].includes(String(value.stage))
		) {
			return value as unknown as RunnerEvent;
		}
		if (
			value.type === "tool" &&
			["started", "completed"].includes(String(value.stage)) &&
			typeof value.name === "string"
		) {
			return value as unknown as RunnerEvent;
		}
		if (value.type === "text_delta" && typeof value.content === "string") {
			return { type: "text_delta", content: value.content };
		}
		return null;
	} catch {
		return null;
	}
}

export function parseRunnerResult(value: string | unknown): RunnerResult {
	const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
	if (!parsed || typeof parsed !== "object") throw new Error("Runner result is not an object.");
	const result = parsed as Record<string, unknown>;
	if (!("delivery" in result)) result.delivery = null;
	if (
		result.version !== 1 ||
		typeof result.ok !== "boolean" ||
		typeof result.output !== "string" ||
		(result.sessionId !== null && typeof result.sessionId !== "string") ||
		!Array.isArray(result.delegations) ||
		(result.error !== null && typeof result.error !== "string") ||
		typeof result.recreatedSession !== "boolean" ||
		!isWorkerDelivery(result.delivery)
	) {
		throw new Error("Runner result has an invalid shape.");
	}
	for (const delegation of result.delegations as unknown[]) {
		if (
			!delegation ||
			typeof delegation !== "object" ||
			!isValidRepository(String((delegation as Record<string, unknown>).repository)) ||
			typeof (delegation as Record<string, unknown>).task !== "string"
		) {
			throw new Error("Runner result contains an invalid delegation.");
		}
	}
	return parsed as RunnerResult;
}

function isWorkerDelivery(value: unknown): boolean {
	if (value === null) return true;
	if (!value || typeof value !== "object") return false;
	const delivery = value as Record<string, unknown>;
	return (
		["not_needed", "pushed", "failed"].includes(String(delivery.status)) &&
		(delivery.branch === null || typeof delivery.branch === "string") &&
		(delivery.commit === null || typeof delivery.commit === "string") &&
		(delivery.error === null || typeof delivery.error === "string")
	);
}

export class JsonLineParser {
	private buffer = "";

	push(chunk: string): RunnerEvent[] {
		this.buffer += chunk;
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? "";
		return lines.map(parseRunnerEvent).filter((event): event is RunnerEvent => event !== null);
	}

	finish(): RunnerEvent[] {
		const event = parseRunnerEvent(this.buffer);
		this.buffer = "";
		return event ? [event] : [];
	}
}
