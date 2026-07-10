# Glasses

> Your coding agents, wherever you are.

Glasses is a self-hosted gateway that lets you chat with coding CLIs —
GitHub Copilot CLI today, Devin CLI next, more to come — over Telegram,
Discord, or WhatsApp, just like you'd talk to them in a terminal. Every
conversation runs in its own isolated [Railway Sandbox](https://docs.railway.com/guides/agents-in-sandboxes),
with your repository cloned and the agent's session preserved between
messages, so you can keep coding without ever opening a local terminal.

Named after Harold Finch — "Glasses," as Lionel Fusco calls him in
*Person of Interest* — the person orchestrating everything from behind the
scenes.

## How it works

```text
You (Telegram/Discord/WhatsApp)
        │
        ▼
   Glasses gateway  ──── Postgres (conversations, messages, jobs)
        │
        ▼
  Railway Sandbox (per conversation)
        │
        ▼
  Coding CLI (Copilot today, Devin next) + your cloned repo
```

- `/new owner/repo [agent]` provisions a fresh sandbox, clones the repo, and
  starts a session with the chosen agent (defaults to `copilot`).
- Plain messages after that are forwarded as prompts to the same agent in
  the same sandbox — full conversational context, exactly like using the
  CLI locally.
- `/status` shows which repo/agent/sandbox your current conversation is
  bound to.

## Status

- ✅ Telegram channel
- ✅ Copilot CLI wrapper (non-interactive `copilot -p`, session resume)
- 🚧 Devin CLI wrapper (interface in place, not yet implemented)
- 🚧 Discord, WhatsApp channels (planned)

## Getting started

### Requirements

- [Bun](https://bun.sh) 1.x
- A Postgres database (Railway can provision one for you)
- A Railway account with [Sandboxes](https://docs.railway.com/guides/agents-in-sandboxes) enabled
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Local development

```bash
bun install
cp .env.example .env   # fill in the values, see below
bun run dev
```

Then point your Telegram bot's webhook at
`https://<your-tunnel>/webhook/telegram` (use a tool like `ngrok` for local
testing).

### Environment variables

See [`.env.example`](./.env.example) for the full list:

| Variable | Description |
|---|---|
| `RAILWAY_API_TOKEN` | Railway API token with Sandbox access |
| `RAILWAY_ENVIRONMENT_ID` | Environment sandboxes are created in |
| `DATABASE_URL` | Postgres connection string |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Only this Telegram user id can talk to the bot |
| `PORT` | HTTP port (default `3000`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `COPILOT_GITHUB_TOKEN` | GitHub token for Copilot CLI auth inside sandboxes |

### Deploying to Railway

1. Push this repo to your own GitHub account (or fork it).
2. Create a new Railway project from the repo — `railway.json` and the
   `Dockerfile` configure the build automatically.
3. Attach a Postgres plugin and set `DATABASE_URL` from it.
4. Set the remaining environment variables in the Railway dashboard.
4. Set your Telegram webhook to `https://<your-railway-domain>/webhook/telegram`.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for more detail on how
the pieces fit together.

## Development

```bash
bun test         # run tests
bun run typecheck # type-check without emitting
bun run build     # compile to dist/
```

## License

MIT
