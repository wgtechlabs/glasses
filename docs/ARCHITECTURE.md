# Architecture

## Responsibilities

The Node 22 Railway service is only a Telegram gateway, durable scheduler, and
Postgres persistence layer. It never runs Copilot against the gateway
filesystem.

```text
Telegram -> gateway -> Postgres jobs -> Railway main sandbox
                                         |
                                         | delegate_task
                                         v
                                  Railway worker sandbox
```

Both sandbox types receive `dist/runner.js`, a JSON input file, and the packaged
Linux Copilot CLI through `sandbox.files.write`; workers also receive the
packaged GitHub CLI. Prompts and tasks are never interpolated into shell
commands. The runner uses `@github/copilot-sdk` without a `model` option,
preserving the authenticated CLI's default provider/model.

## Main sessions

There is one main conversation for `(channel, user_id, chat_id)`. Plain
Telegram messages create it automatically and enqueue a `main_turn`; `/new` no
longer provisions anything. Main turns are claimed with
`FOR UPDATE SKIP LOCKED` and serialized per conversation.

The main runner exposes `delegate_task(repository, task)` plus a small
read-only allowlist for GitHub metadata, issues, pull requests, workflow runs,
web search, and web fetch. Information requests stay in the main session;
checkout, edit, test, and build work is delegated. The delegation handler
validates and records requests in the structured runner result, with no callback
endpoint from a sandbox to the gateway.

Railway's idle timeout destroys inactive main sandboxes. The next turn detects a
missing/stale sandbox, creates a replacement, and restores a bounded recent
message transcript and worker summaries from Postgres. Copilot session IDs are
resumed while the same sandbox remains available.

## Workers and concurrency

Each delegation is a durable `worker` job and receives a fresh sandbox. The
runner uses argument-array process spawning to execute authenticated
`gh repo clone owner/repo`, then runs a Copilot SDK session in that repository.
Repository-local Copilot instruction discovery remains enabled.

A partial unique index and claim query permit one running worker per
`(conversation, repository)`. Different repositories may be claimed
concurrently. Worker sandboxes are explicitly destroyed in `finally`.

Worker completion is stored transactionally with a synthetic `worker_result`
main turn. That serialized main turn produces the coherent Telegram response.
Sandbox lifecycle and tool events remain internal gateway diagnostics. Main
Copilot SDK text deltas are relayed through Telegram's ephemeral
`sendMessageDraft` stream, followed by one persistent completed reply.

## Durability and restarts

Jobs persist sandbox IDs, Railway durable exec session names, claim times, and
results. On startup, running jobs are reattached through Railway SDK v3
`exec({ sessionName })`. If the sandbox/session is unavailable, the job is
explicitly failed (and worker failure is queued through the main session);
repository edits are never silently retried.

Postgres schema changes are additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
operations in `Database.initialize()`, preserving early deployments. Telegram
message IDs are unique for webhook deduplication.

## Instructions and security

Global instructions are keyed by channel/user in Postgres and applied to main
and worker system messages. Changing them clears and destroys the current main
sandbox so the next turn uses the new instructions. Repo-local instruction
files are handled by Copilot.

Repositories must be strict `owner/repository` identifiers. The Telegram
allowlist is enforced before persistence. `COPILOT_GITHUB_TOKEN` is passed only
as sandbox environment configuration (also as `GH_TOKEN` for private clones);
it is not logged, included in prompts, or passed through per-exec command
strings.

Devin is deliberately deferred and is not registered as a working backend.
Railway Sandboxes and the Copilot SDK are preview/beta dependencies and may
introduce breaking API changes.
