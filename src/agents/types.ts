/**
 * Contract every coding-CLI wrapper implements. A conversation is bound to
 * one agent for its lifetime; the registry looks agents up by name so new
 * CLIs (Claude, Aider, ...) can be added without touching the channel or
 * gateway layers.
 */
export interface AgentLike {
  readonly name: string;

  /**
   * Ensures the sandbox has the CLI installed/authenticated and the
   * repository cloned. Safe to call on every message — implementations
   * should no-op when setup already happened.
   */
  ensureReady(sandboxId: string, repository: string): Promise<void>;

  /**
   * Sends one prompt to the agent's CLI running in the sandbox and
   * returns its response. Implementations that support durable sessions
   * (e.g. `copilot -r`) should resume the prior turn using
   * `conversationSessionId` so multi-turn context is preserved exactly
   * like talking to the CLI locally.
   */
  send(input: AgentSendInput): Promise<AgentSendResult>;
}

export interface AgentSendInput {
  sandboxId: string;
  repository: string;
  repositoryPath: string;
  prompt: string;
  conversationSessionId: string | null;
}

export interface AgentSendResult {
  output: string;
  /** Session id to persist and pass back in on the next turn, if the CLI exposes one. */
  sessionId: string | null;
  succeeded: boolean;
}
