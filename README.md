# Mushin.js 無心

An agent-powered chatbot framework where everything is a plugin. Describe what you want, in plain words, and the built-in Agent sets it up: providers, bots, plugins and pages in the dashboard.

Mushin.js is built on [Cordis](https://github.com/cordiverse/cordis). The MVP ships a OneBot v11 adapter for [NapCat](https://napneko.github.io/), so bots run on QQ.

## What is in the MVP

| Area | What you get |
| --- | --- |
| Plugin architecture | Every feature is a Cordis plugin. App plugins extend Mushin.js; bot plugins run per bot, each bot in its own isolated context. |
| Agent | A chat dock on every page. It operates the instance through the same actions the dashboard uses, asks before dangerous ones, and can open pages and point at controls. |
| Providers | OpenAI-compatible endpoints (OpenAI, DeepSeek, Moonshot, Qwen, SiliconFlow, OpenRouter, Ollama) and Anthropic. Keys are masked everywhere. |
| Overview | The start page: bots online, today's messages and model tokens, flows with errors, commands, providers and plugins; a message chart for 24 hours or 7 days per bot; the busiest chats, users, commands, flows and models; live CPU, memory and event loop delay; versions, uptime and data directory size. |
| Bots | Create, start, stop and configure bots; enable bot plugins per bot; each bot's commands and `/help`. |
| OneBot adapter | OneBot v11 over WebSocket, in forward mode (Mushin dials NapCat) or reverse mode (NapCat dials Mushin), or over HTTP (API calls plus signed event reports). |
| Conversation flows | A visual editor for bot behavior: wire triggers, conditions, variables, LLM calls and replies into a graph, test it with a made-up message, and watch live runs light up the path. The Agent can build flows too. |
| Live conversation view | Messages appear as they arrive. Hover a message to see its type, supported platforms and what generated it (an LLM with provider and model, a plugin, or a flow). |
| Dashboard | Vue 3 + Naive UI, English and Simplified Chinese, light and dark themes, works on phones. |

The plugin marketplace is designed but not built yet; see [docs/architecture.md](docs/architecture.md).

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

To try things inside your own instance instead, enable **Demo** (`@mushin/plugin-demo`) on the **Plugins** page. It adds a *Demo (offline)* provider type that answers without an API key, a *Demo sandbox* bot adapter that is always online, and a sandbox bot to try flows on. Nothing is created until you tick it in the plugin's settings:

- **Create the demo provider**: a provider of the offline type.
- **Create the demo bot**: a sandbox bot. In its live conversation view you play the test user: what you send is received by the bot as the test user's message (start with `@` to mention the bot). The Agent can do the same with the `demo.say` action.
- **Sample flows**: command reply (`/ping`, `/echo`), keyword trigger, condition branch (`/score 85`), cooldown and counter (`/checkin`), wait for a reply with a timeout (`/quiz`), LLM reply (`/ai`) and intent classification (`/客服`). They run on the demo bot when it exists, and the bot's built-in `/help` lists their commands.

Unticking an item deletes it, and disabling the plugin deletes everything it created. Edit a sample flow freely, but untick it before you disable the plugin if you want to keep a copy.

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

**HTTP mode.** Create the bot with mode `http` and URL of NapCat's HTTP server, such as `http://127.0.0.1:3000`; Mushin calls the OneBot API there. In NapCat also add an HTTP client that posts events to `http://<mushin-host>:5160/onebot/<bot id>` (shown on the Connection tab). If the HTTP client has a `secret`, set the same **Report secret** on the bot; events whose `X-Signature` does not match are refused. The bot counts as online once NapCat answers `get_login_info`, retrying every 30 seconds.

```json
{ "name": "HttpServer", "enable": true, "port": 3000, "messagePostFormat": "array", "token": "your-token" }
{ "name": "HttpClient", "enable": true, "url": "http://127.0.0.1:5160/onebot/<bot id>", "messagePostFormat": "array", "token": "your-token", "secret": "your-secret" }
```

The bots list shows each bot's connection mode and address, with a switch to start or stop it. A bot's **Flow overview** tab lists, in order, everything a message passes on that bot: the flow triggers by priority, the built-in commands and the bot plugins. Type a message there and pick who sends it (group member, admin, owner, the bot's admin, or a private chat) to see which triggers it starts, the path each run takes, what it replies and which plugins never see it, all in test mode; LLM nodes answer with a placeholder unless you allow real calls. The Agent can do the same with `flows.route`.

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

## Conversation flows

Open **Flows** in the dashboard (cards or a compact list, grouped by trigger, adapter, bot or when they were last edited, with filters and sorting that stay in the address bar) and create a flow from a template, or ask the Agent ("when someone says hello, greet them and count visitors"). A flow is a graph of nodes:

- **Connections** only say what runs next. Branching nodes have one output per outcome, listed on the right edge of the node, such as `true`/`false` or one per intent label.
- **Values** move by reference, as in Dify: a node's input, or any text in its settings, can read `{{<node id>.<output>}}` from a node that ran earlier (for example `{{n1.rest}}` or `{{llm.reply}}`), `{{sys.text}}` / `{{sys.user}}` for the incoming message, and `{{chat.<name>}}`, `{{user.<name>}}`, `{{flow.<name>}}` for stored variables. Press **(x)** next to an input to pick one. Flows saved with the older data connections are converted on load.

| Category | Nodes |
| --- | --- |
| Triggers | On message (any, mentions, private, group), Keyword, Command, Pattern (regular expression), On schedule (daily, every N minutes, cron) |
| Event triggers (OneBot) | Member joined, Member left, Poke, Message recalled (with the recalled text), Mute changed, Admin changed, File uploaded, New friend, Friend request, Group request / invitation, Group info changed (card, name, title, essence, reactions), Group honor / lucky king, Any OneBot event |
| Logic | If, Compare (branches on true / false), Random chance, Cooldown, Wait, Wait for reply |
| Data | Text (with `{a}` `{b}` `{c}` `{user}` `{message}`), Message info, Get variable, Set variable, Add to number |
| AI | Ask the LLM, Classify intent (one branch per label) |
| Actions | Reply, Send to chat |
| Group management (OneBot) | Mute, Mute everyone, Remove member, Set admin, Set member card, Set special title, Rename group, Post announcement, Essence message, Group check-in, Leave group |
| Platform API (OneBot) | Recall message, Get message, Send forward message, Poke, React with emoji, Like profile, Handle request, Member info, User info, Group info, Sender role, Call OneBot API (any OneBot 11 or NapCat action) |

OneBot nodes call NapCat through the bot running the flow and continue on `ok` or `failed`, with the error as an output, so a missing permission does not stop the run. **Wait for reply** holds the run until the next message in the chat (up to an hour; waiting does not count toward the 60-second run limit), and the awaited message does not start other flows. Event and schedule runs reply in the chat the event happened in, or the one set on the schedule trigger.

Pick the flow's adapter at the top of the editor (it is chosen for you when only one is installed); nodes made for another adapter, such as the OneBot ones on a Discord flow, are greyed out in the node list, and hovering one says why. Right-click the canvas, a node, a selection or a connection for more: add a node where you clicked, copy and paste (Ctrl+C / Ctrl+V, also between flows), duplicate (Ctrl+D), group selected nodes into a dashed frame that moves and copies as one (Ctrl+G; Ctrl+Shift+G ungroups), or insert a node into a connection. **Skip** a node from the same menu, or with the eye button next to the delete button in its settings, to keep it on the canvas without running it: a skipped trigger never fires, and a skipped step passes straight on to its first exit. Nodes that only a skipped trigger leads to are shown as skipped too, since they never run. A group can be collapsed into one box with the button on its frame, and double-clicking the box expands it again. Dropping a connection on empty canvas lists the nodes that can connect there. Then pick the bots that run the flow; Mushin.js turns on the flows bot plugin for them. When a flow's trigger matches, the message stops there, so the bot's other plugins, such as LLM chat, don't answer it too. Turn on **Let other plugins answer too** on the trigger to change that. The **Logs** bar under the canvas sends a made-up message, event or schedule tick through the saved flow without sending anything to a chat or calling NapCat (AI nodes do call the LLM; the platform calls the run would make are listed) and lists every step with its input and output, as a table or JSON. **Execute step** on a node, or ▶ on its card, runs the same test but stops after that node. Recent live runs appear there too; pick one to highlight its path on the canvas. While a run is going, the edge into the running node is a moving dashed line, and edges turn green or red as each node succeeds or fails.

When one message starts several triggers on a bot, across all of its flows, they run highest **priority** first (ties: older flow first), and a trigger that does not let other plugins answer too stops the ones after it. Event and schedule triggers have a switch for the same. A trigger's settings list the triggers that compete with it on each bot, with buttons to run it earlier or later. A trigger that an earlier one always keeps the message from is marked **Never runs** on the canvas, with the trigger in its way, and so are the steps only it leads to.

Turn a flow off with the switch on its card or at the top of the editor: it keeps its content and bots but answers no messages, events or schedules, and its commands leave `/help`, until it is turned on again.

Variables live in memory and reset when Mushin.js restarts.

### Commands

A **Command** trigger answers a command such as `/checkin`: a name, aliases, a description and optional arguments written as a signature, for example `<score:number> [note]` (`<>` required, `[]` optional, `:number` a number, the last text argument takes the rest). Each argument becomes an output of the same name, so `{{n1.score}}` reads it; names may be in any script, such as `{{n1.分数}}`. When the arguments do not fit, the bot replies with the usage instead of running the flow. A Keyword trigger matches `/foo` as plain text; when a keyword starts with `/`, the settings offer to turn the node into a Command trigger (it keeps its id, so `{{n1.rest}}` still works), and removing the `/` from a command's name offers to turn it back.

Every bot has a command list on its **Commands** tab: command nodes from the flows on the bot, commands that bot plugins register with `ctx.bot.command()`, and the built-in `/help`, which answers with the list unless a flow or plugin handles `/help` itself. The same tab sets the bot's prefixes (default `/`; `#` or `!` work too), the first line of `/help`, and the admins allowed to run admin-only commands. Two sources registering the same name on one bot are flagged in the list and as a warning on the flow. The `commands.list` action gives the Agent the same list.

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
| `@mushin/plugin-flows` | Flow documents, node types, validation and the execution engine |
| `@mushin/plugin-stats` | Hourly counts of messages, commands, flow runs and model usage (kept hourly for 30 days, daily for a year, in `data/stats/`) and process samples for the overview |
| `@mushin/bot-plugin-echo`, `@mushin/bot-plugin-llm-chat`, `@mushin/bot-plugin-flows` | Bot plugins |
| `@mushin/plugin-demo` | Offline demo provider, sandbox bot adapter and sample flows (opt-in) |
| `@mushin/dashboard` | The Vue 3 dashboard |

To write your own plugin, see [docs/plugin-guide.md](docs/plugin-guide.md).

## Status

This is an MVP. Cordis 4 is still a release candidate, so the core pins `cordis@4.0.0-rc.11`. Plugins run in-process with full access to the instance; only install plugins you trust.

## License

MIT
