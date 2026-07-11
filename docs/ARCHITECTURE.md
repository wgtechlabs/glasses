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
Linux Copilot CLI through `sandbox.files.write`. Worker clones use the sandbox's
Git binary with authentication passed through process environment configuration.
Prompts and tasks are never interpolated into shell commands. The runner uses
`@github/copilot-sdk` without a `model` option, preserving the authenticated
CLI's default provider/model.

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
endpoint from a sandbox to the gateway. Every turn receives routing guidance so
resumed sessions use read-only tools for lookups and reserve delegation for
checkout, modification, command, test, and build work. Internal tool details are
not included in user-facing replies.

Railway destroys main sandboxes after 25 idle minutes. The next turn detects a
missing/stale sandbox, creates a replacement, and restores a bounded recent
message transcript and worker summaries from Postgres. Copilot session IDs are
resumed while the same sandbox remains available.

## Workers and concurrency

Each delegation is a durable `worker` job and receives a fresh sandbox. The
runner uses argument-array process spawning to execute an authenticated, shallow
`git clone`, then runs a Copilot SDK session in that repository. Repository-local
Copilot instruction discovery remains enabled.

A partial unique index and claim query permit one running worker per
`(conversation, repository)`. Different repositories may be claimed
concurrently. Worker sandboxes have a 15-minute idle timeout and are explicitly
destroyed only after the changes are pushed or checkpointed.

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

After the Copilot session finishes, the runner commits any remaining working
tree changes and pushes the current branch with a one-command authentication
header. A failed push is captured as a named Railway checkpoint and retried once
without starting another Copilot session. If delivery still fails, the
checkpoint remains durable and is requeued after the gateway restarts.

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
it is not logged or included in prompts. Git clone and push receive it through
ephemeral process environment configuration, so it is not stored in repository
configuration or Railway checkpoints.

Devin is deliberately deferred and is not registered as a working backend.
Railway Sandboxes and the Copilot SDK are preview/beta dependencies and may
introduce breaking API changes.
