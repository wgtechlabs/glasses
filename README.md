# Glasses

![GitHub Repo Banner](https://ghrb.waren.build/banner?header=Glasses+%F0%9F%91%93&subheader=Your+coding+agents%2C+wherever+you+are.&bg=013B84-016EEA&color=FFFFFF&headerfont=Inter&subheaderfont=Kinewave&watermarkpos=bottom-right)
<!-- Created with GitHub Repo Banner by Waren Gonzaga: https://ghrb.waren.build -->

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0) [![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/) [![Node.js](https://img.shields.io/badge/NodeJS-Runtime-green.svg)](https://nodejs.org/) [![BunJS](https://img.shields.io/badge/BunJS-Toolchain-F9F1E1.svg)](https://bun.sh/) [![Docker Hub](https://img.shields.io/badge/Docker%20Hub-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/wgtechlabs/glasses) [![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-181717?logo=github&logoColor=white)](https://github.com/wgtechlabs/glasses/pkgs/container/glasses)

Coding should not stop when you leave your terminal. Glasses is a self-hosted Telegram
gateway that coordinates GitHub Copilot coding work in isolated
[Railway Sandboxes](https://docs.railway.com/guides/agents-in-sandboxes).

## 💡 Inspiration

I really like _Harold Finch_ ("Glasses," as _Lionel Fusco_ calls him) from the TV series _Person of Interest_ because he is the mind behind _The Machine_, the ultimate AI he built in the story. This project takes inspiration from that same behind-the-scenes orchestration: one quiet control point coordinating agents, repositories, and sandbox sessions so real coding work keeps moving from simple chat messages.

## 🧭 How it works

```text
You (Telegram/Discord/WhatsApp)
        │
        ▼
   Glasses gateway  ──── Postgres (conversations, messages, jobs)
        │
        ▼
  Railway main sandbox (Copilot SDK orchestration)
       │ delegate_task
        ▼
  Fresh Railway worker sandbox + cloned repository
```

- Send a plain message containing a repository and task. Glasses automatically
  creates or resumes one main session (Copilot by default) for that Telegram
  user/chat.
- The main session can call native `delegate_task(owner/repo, task)`. Every task
  gets a fresh worker sandbox; different repositories can run concurrently and
  work for the same repository is serialized.
- `/new owner/repo [copilot|devin] [model]` pins the main session repository and
  agent for upcoming turns.
- `/model [name]` shows or updates the active model (Devin defaults to `swe-1.7`).
- `/status` shows agent/model/repository plus queued/running main turns and workers.
- `/instructions`, `/instructions set <text>`, and `/instructions clear` manage
  DB-backed global instructions used by main and worker sessions.

## 📊 Status

- ✅ Telegram channel
- ✅ Copilot SDK main/worker sandbox orchestration
- ✅ Durable Postgres job claims and bounded session rehydration
- ✅ Devin CLI main-session support (`devin -p` with optional `--continue`)
- 🚧 Discord, WhatsApp channels (planned)

## 🚀 Getting started

### 📋 Requirements

- [Node.js](https://nodejs.org) >=22 (the gateway runtime)
- [Bun](https://bun.sh) 1.x (dependency management, development, and builds)
- A Postgres database (Railway can provision one for you)
- A Railway account with [Sandboxes](https://docs.railway.com/guides/agents-in-sandboxes) enabled
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### ⚙️ Runtime

Glasses runs on **Node.js**. Bun is the toolchain for dependency management,
development, and bundling (`bun install`, `bun run dev`, and `bun run build`).
The Docker image uses Bun only while building; the final runtime image is
plain Node.js with no Bun present.

### 💻 Local development

```bash
bun install
cp .env.example .env   # fill in the values, see below
bun run dev
```

Then point your Telegram bot's webhook at
`https://<your-tunnel>/webhook/telegram` (use a tool like `ngrok` for local
testing).

### 🔐 Environment variables

See [`.env.example`](./.env.example) for the full list:

| Variable | Description |
|---|---|
| `RAILWAY_API_TOKEN` | Railway API token with Sandbox access |
| `RAILWAY_ENVIRONMENT_ID` | Environment sandboxes are created in (provided automatically on Railway) |
| `RAILWAY_PUBLIC_DOMAIN` | Public domain used to register the Telegram webhook (provided automatically on Railway) |
| `JOB_TIMEOUT_SECONDS` | Sandbox runner timeout |
| `SCHEDULER_POLL_MS` | Durable scheduler polling interval |
| `SCHEDULER_WORKER_CONCURRENCY` | Maximum workers claimed by this gateway process |
| `DATABASE_URL` | Postgres connection string |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Only this Telegram user id can talk to the bot |
| `PORT` | HTTP port (default `3000`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `COPILOT_GITHUB_TOKEN` | GitHub token for Copilot auth and worker Git delivery |
| `DEVIN_CREDENTIALS_BASE64` | Base64 of `credentials.toml` for Devin CLI auth in sandboxes |
| `MEMORY_MESSAGE_LIMIT` | Recent main-chat messages restored after sandbox loss |
| `MEMORY_WORKER_LIMIT` | Recent worker summaries restored after sandbox loss |

`COPILOT_GITHUB_TOKEN` is injected into the isolated sandbox environment for
Copilot and authenticated Git operations (including private repositories). It
needs repository **Contents: read/write** and **Pull requests: read/write**.
Worker pushes use a one-command Git authentication header; credentials are not
stored in the clone or checkpoint.

> Railway Sandboxes and `@github/copilot-sdk` are preview/beta APIs. Pin and
> review dependency updates because their APIs may change.

### 🚂 Deploying to Railway

1. Push this repo to your own GitHub account (or fork it).
2. Create a new Railway project from the repo — `railway.json` and the
   `Dockerfile` configure the build automatically.
3. Attach a Postgres plugin and set `DATABASE_URL` from it.
4. Set the remaining environment variables in the Railway dashboard.
5. The service automatically registers its Telegram webhook using its Railway domain.

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for more detail on how
the pieces fit together.

## 🛠️ Development

```bash
bun test         # run tests
bun run typecheck # type-check without emitting
bun run lint      # check formatting/lint with biome
bun run build     # bundle to dist/ (target: node)
```

## 💬 Community Discussions

Join our community discussions to get help, share ideas, and connect with other users:

- 📣 **[Announcements](https://github.com/wgtechlabs/glasses/discussions/categories/announcements)**: Official updates from the maintainer
- 📸 **[Showcase](https://github.com/wgtechlabs/glasses/discussions/categories/showcase)**: Show and tell your implementation
- 💖 **[Wall of Love](https://github.com/wgtechlabs/glasses/discussions/categories/wall-of-love)**: Share your experience with the bot
- 🛟 **[Help & Support](https://github.com/wgtechlabs/glasses/discussions/categories/help-support)**: Get assistance from the community
- 🧠 **[Ideas](https://github.com/wgtechlabs/glasses/discussions/categories/ideas)**: Suggest new features and improvements

## 🛟 Help & Support

Need help? Check our [Help & Support](https://github.com/wgtechlabs/glasses/discussions/categories/help-support) discussions or [create a new issue](https://github.com/wgtechlabs/glasses/issues/new/choose).

## 🎯 Contributing

**Important**: Submit pull requests to the `dev` branch following the repository workflow.

Contributions are welcome! Your code must pass `bun run typecheck` before merging.

## 💖 Sponsors

Like this project? **Leave a star**! ⭐⭐⭐⭐⭐

There are several ways you can support this project:

- [Become a sponsor](https://github.com/sponsors/wgtechlabs) and get some perks! 💖
- [Buy us a coffee](https://buymeacoffee.com/wgtechlabs) if you love what we do! ☕

## ⭐ GitHub Star Nomination

Found this project helpful? Consider nominating me **(@warengonzaga)** for the [GitHub Star program](https://stars.github.com/nominate/)! This recognition supports ongoing development of this project and [my other open-source projects](https://github.com/warengonzaga?tab=repositories). GitHub Stars are recognized for their significant contributions to the developer community. Your nomination makes a difference and encourages continued innovation!

## 📃 License

This project is licensed under [GPL-3.0-or-later](https://spdx.org/licenses/GPL-3.0-or-later.html).

## 📝 Author

This project is created by **[Waren Gonzaga](https://github.com/warengonzaga)** under [WG Technology Labs](https://github.com/wgtechlabs), with the help of awesome [contributors](https://github.com/wgtechlabs/glasses/graphs/contributors).

[![contributors](https://contrib.rocks/image?repo=wgtechlabs/glasses)](https://github.com/wgtechlabs/glasses/graphs/contributors)

---

💻💖☕ by [Waren Gonzaga](https://warengonzaga.com) | [YHWH](https://www.youtube.com/watch?v=VOZbswniA-g) 🙏 - Without _Him_, none of this exists, _even me_.
