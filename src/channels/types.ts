/**
 * Contract every chat channel implements. A channel only knows about
 * `AgentLike` and `Database` through the gateway; it never talks to
 * Railway directly.
 */
export interface ChannelLike {
	readonly name: string;
	handleWebhook(payload: unknown): Promise<void>;
}
