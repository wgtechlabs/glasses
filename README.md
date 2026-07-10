# Glasses

> Your coding agents, wherever you are.

Coding should not stop when you leave your terminal. Glasses brings your coding agents wherever you are: it is a self-hosted gateway that lets you direct GitHub Copilot CLI, Devin CLI, and other agents through Telegram, Discord, or WhatsApp, while each conversation runs in its own isolated [Railway Sandbox](https://docs.railway.com/guides/agents-in-sandboxes) with your repository cloned and session preserved, so you can build, review, and ship from a simple chat.

Named after Harold Finch ("Glasses," as Lionel Fusco calls him in
*Person of Interest*), the person orchestrating everything from behind the
scenes.

## 🧭 How it works

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

## 📊 Status

- ✅ Telegram channel
- ✅ Copilot CLI wrapper (non-interactive `copilot -p`, session resume)
- 🚧 Devin CLI wrapper (interface in place, not yet implemented)
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
plain Node.js Alpine with no Bun present.

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
| `RAILWAY_ENVIRONMENT_ID` | Environment sandboxes are created in |
| `DATABASE_URL` | Postgres connection string |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Only this Telegram user id can talk to the bot |
| `PORT` | HTTP port (default `3000`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |
| `COPILOT_GITHUB_TOKEN` | GitHub token for Copilot CLI auth inside sandboxes |

### 🚂 Deploying to Railway

1. Push this repo to your own GitHub account (or fork it).
2. Create a new Railway project from the repo — `railway.json` and the
   `Dockerfile` configure the build automatically.
3. Attach a Postgres plugin and set `DATABASE_URL` from it.
4. Set the remaining environment variables in the Railway dashboard.
4. Set your Telegram webhook to `https://<your-railway-domain>/webhook/telegram`.

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
