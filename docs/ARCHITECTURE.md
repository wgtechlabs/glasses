# Architecture

## Overview

Glasses is a single Node.js HTTP service (`src/index.ts`, built with Bun) with
four layers:

```text
channels/   → parses inbound chat platform payloads, replies to users
agents/     → wraps each coding CLI's actual invocation
sandbox.ts  → provisions and drives Railway Sandboxes
db.ts       → persists conversations, messages, jobs in Postgres
```

Nothing above the `agents/` layer knows how a specific CLI is invoked;
nothing above `sandbox.ts` knows it's talking to Railway. This keeps adding
a new chat channel (Discord, WhatsApp) or a new coding CLI (Claude, Aider)
additive rather than invasive.

## Conversation lifecycle

1. **`/new owner/repo [agent]`** — the channel asks `SandboxManager` to
   create a sandbox, then asks the chosen `AgentLike.ensureReady()` to
   clone the repository into it. A `Conversation` row is persisted mapping
   `(channel, userId)` → `(agent, repository, sandboxId, sessionId)`.
2. **Plain message** — the channel looks up the user's latest
   conversation, forwards the message text to `AgentLike.send()` along with
   the stored `sessionId` (if the CLI supports resuming), and persists any
   new session id returned. The CLI's response is relayed back verbatim.
3. **`/status`** — reads the stored conversation and reports which
   repo/agent/sandbox it's bound to.

Only one active conversation per `(channel, userId)` is currently tracked
— `getLatestConversationForUser` always resolves to the most recently
started one. Supporting multiple concurrent conversations per user is a
natural extension (e.g. `/switch <conversation-id>`) but isn't built yet.

## Agent wrappers

`AgentLike` (`src/agents/types.ts`) is intentionally CLI-shaped, not
protocol-shaped: `ensureReady(sandboxId, repository)` then
`send({ prompt, conversationSessionId, ... })`. This mirrors how you'd
actually drive these tools by hand:

- **Copilot** (`src/agents/copilot.ts`) shells out to
  `copilot -p "<prompt>" -s --allow-all-tools --no-ask-user`, optionally
  with `--resume <sessionId>`, inside the sandbox via `SandboxManager.exec`.
  Auth is expected to already be present in the sandbox environment
  (`COPILOT_GITHUB_TOKEN` or a pre-authenticated `gh` CLI).
- **Devin** (`src/agents/devin.ts`) is a skeleton only — `send()` reports
  a friendly "not implemented" message. Wiring it up means shelling out to
  `devin -p "<prompt>"` / `devin -r <id>` the same way Copilot does.

Both are registered in `src/agents/registry.ts`, which is the only place
that needs to change to add a new CLI.

## Why Railway Sandboxes

Each conversation's sandbox holds the cloned repository and whatever local
state the CLI accumulates (git history, build caches, CLI session files).
Reusing the same sandbox id across messages is what makes a chat
conversation behave like a persistent terminal session instead of a fresh
container per message. Sandboxes are created with `networkIsolation` set
so agent code can't reach anything outside the sandbox except what's
explicitly allowed.

## Deliberately deferred

- Discord and WhatsApp channels — same `ChannelLike` contract, no gateway
  changes needed.
- Devin CLI real implementation.
- Sandbox idle cleanup / cost controls beyond the SDK's own
  `idleTimeoutMinutes`.
- Multi-conversation-per-user support.
