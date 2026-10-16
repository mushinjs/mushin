# Mushin.js 無心

An agent-powered chatbot framework where everything is a plugin. Describe what you want, in plain words, and the built-in Agent sets it up: providers, bots, plugins and pages in the dashboard.

Mushin.js is built on [Cordis](https://github.com/cordiverse/cordis). The MVP ships a OneBot v11 adapter for [NapCat](https://napneko.github.io/), so bots run on QQ.

## What is in the MVP

| Area | What you get |
| --- | --- |
| Plugin architecture | Every feature is a Cordis plugin. App plugins extend Mushin.js; bot plugins run per bot, each bot in its own isolated context. |
| Agent | A chat dock on every page. It operates the instance through the same actions the dashboard uses, asks before dangerous ones, and can open pages and point at controls. |
| Providers | OpenAI-compatible endpoints (OpenAI, DeepSeek, Moonshot, Qwen, SiliconFlow, OpenRouter, Ollama) and Anthropic. Keys are masked everywhere. |
| Bots | Create, start, stop and configure bots; enable bot plugins per bot. |
| OneBot adapter | OneBot v11 over WebSocket, in forward mode (Mushin dials NapCat) or reverse mode (NapCat dials Mushin). |
| Live conversation view | Messages appear as they arrive. Hover a message to see its type, supported platforms and what generated it (an LLM with provider and model, a plugin, or a flow). |
| Dashboard | Vue 3 + Naive UI, English and Simplified Chinese, light and dark themes, works on phones. |

The plugin marketplace and the visual flow editor are designed but not built yet; see [docs/architecture.md](docs/architecture.md).

## Quick start

You need Node.js 22.12 or later and pnpm.

```sh
pnpm install
pnpm build      # builds the dashboard
pnpm start      # starts Mushin.js in ./instance
```

Every start prints a sign-in link and the admin token:

```
  Mushin.js dashboard: http://127.0.0.1:5160
  Sign in:     http://127.0.0.1:5160/login#token=qUdh_kYfFr08_...
  Admin token: qUdh_kYfFr08_...
  New token:   mushin token reset --dir instance
```

Open the sign-in link, then follow **Quick setup** to connect an LLM provider. After that, ask the Agent, for example: *"Connect a QQ bot through NapCat at ws://127.0.0.1:3001 and turn on LLM chat."*

- The token is kept in `instance/data/auth.json`, so it stays the same across restarts.
- To replace it, run `pnpm exec mushin token reset`. A running Mushin.js accepts the new token at once and the old one stops working.
- Prefer a fixed token? Set `MUSHIN_ADMIN_TOKEN` before starting.
- The server listens on `127.0.0.1:5160`. Change host and port in `instance/mushin.config.json` (the `server` entry).

### Try it without QQ or an API key

```sh
pnpm build
pnpm demo
```

This starts an instance wired to a mock NapCat and a mock LLM, with a provider, two bots, some chat traffic and an Agent conversation already in place. Sign in with the token `demo`.

## Connecting NapCat

Set NapCat's message format to `array` and use the same access token on both sides.

**Forward mode (Mushin connects to NapCat).** In NapCat's network settings add a WebSocket server, for example on port 3001. Create the bot with mode `forward` and URL `ws://127.0.0.1:3001`.

```json
{ "name": "WsServer", "enable": true, "host": "0.0.0.0", "port": 3001, "messagePostFormat": "array", "token": "your-token" }
```

**Reverse mode (NapCat connects to Mushin).** Create the bot with mode `reverse`. The bot's Connection tab shows the address to use, `ws://<mushin-host>:5160/onebot/<bot id>`. In NapCat add a WebSocket client pointing at it.

```json
{ "name": "WsClient", "enable": true, "url": "ws://127.0.0.1:5160/onebot/<bot id>", "messagePostFormat": "array", "token": "your-token" }
```

If Mushin.js and NapCat run on different machines, bind Mushin.js to a reachable address (`host` in the server entry) and keep the admin token private.

When a bot misbehaves, open its **Logs** tab. It lists what happened inside that bot only: every connection attempt (address, NapCat self id, client role, and why a token was rejected), logins, status changes, plugin warnings, and why LLM chat skipped a message. The same lines are saved in `instance/data/logs/<bot id>/` and the Agent can read them.

## Keeping LLM chat in check

The LLM chat bot plugin checks these limits before every model call. Change them on the bot's **Plugins** tab, or ask the Agent.

| Setting | Default | Effect |
| --- | --- | --- |
| Reply in private chats | on | Turn off to answer only in groups |
| Only these groups | all groups | Group ids the bot may answer in |
| Ignore users | none | User ids never answered, such as other bots |
| Chat cooldown | 3 s | Least time between two replies in one chat |
| Replies per user | 5 per 60 s | Per-user rate limit, with an optional one-time notice |
| Daily reply limit | 300 | LLM replies per bot per day; resets at local midnight and survives restarts |
| Daily token budget | off | Tokens per bot per day, as reported by the provider |
| Message length | 1000 characters | Longer messages are cut before they reach the model |

A chat also gets only one model call at a time; messages that arrive while a reply is being written are not answered. When a daily limit is reached, the Logs page says so once.

## Development

```sh
pnpm dev          # backend on :5160 and the dashboard dev server on :5173 (proxying /api)
pnpm test         # unit and end-to-end tests (mock NapCat and mock LLM)
pnpm typecheck    # TypeScript for all packages, vue-tsc for the dashboard
```

| Package | Role |
| --- | --- |
| `@mushin/core` | Action registry, plugin manager, message and provenance types |
| `@mushin/cli` | `mushin start` and `mushin token reset` |
| `@mushin/plugin-storage` | JSON documents in the data directory |
| `@mushin/plugin-providers` | Provider records and the `llm` service |
| `@mushin/plugin-provider-openai`, `@mushin/plugin-provider-anthropic` | Provider types |
| `@mushin/plugin-bots` | Bot records, per-bot runtimes, sessions, message records |
| `@mushin/plugin-adapter-onebot` | OneBot v11 adapter |
| `@mushin/plugin-agent` | The Agent's tool loop |
| `@mushin/plugin-console` | HTTP API, WebSocket, admin token, dashboard hosting |
| `@mushin/bot-plugin-echo`, `@mushin/bot-plugin-llm-chat` | Bot plugins |
| `@mushin/dashboard` | The Vue 3 dashboard |

To write your own plugin, see [docs/plugin-guide.md](docs/plugin-guide.md).

## Status

This is an MVP. Cordis 4 is still a release candidate, so the core pins `cordis@4.0.0-rc.11`. Plugins run in-process with full access to the instance; only install plugins you trust.

## License

MIT
