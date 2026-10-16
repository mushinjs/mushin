# Architecture (as built)

The full design, including the plugin marketplace and the flow editor, lives in the design document *Mushin.js — Architecture & MVP Design*. This page records how the MVP implements it.

## Startup

`mushin start` (`packages/cli`) reads `mushin.config.json` from the instance directory, creating a default one on first run. It then builds the root Cordis context, loads the `actions` registry and the plugin manager (`ctx.manager`), and the manager loads each enabled entry in the config. Cordis orders loading through `inject`: a plugin starts once every service it injects is active.

```
root context
├── actions              @mushin/core       typed operations, shared by API and Agent
├── manager              @mushin/core       app plugin entries, catalog, mushin.config.json
├── server               @cordisjs/plugin-server
├── storage              @mushin/plugin-storage
├── llm                  @mushin/plugin-providers   (+ openai, anthropic provider types)
├── bots                 @mushin/plugin-bots        (+ onebot adapter type)
│   └── ctx.isolate('bot') per bot
│       ├── bot          the bot service
│       ├── adapter connection
│       └── enabled bot plugins
├── agent                @mushin/plugin-agent
└── console              @mushin/plugin-console     REST, WebSocket, dashboard
```

## Actions

Every operation is an action: a dotted name, a description written for the Agent, a zod input schema and a risk level (`read`, `write`, `dangerous`). Actions are registered with `ctx.actions.define()` and removed when their plugin unloads.

- HTTP: `POST /api/actions/<name>` with a JSON body; `GET /api/actions` lists them with JSON Schemas.
- WebSocket: `{ type: 'call', id, action, input }` on `/api/ws`. Calls over the socket carry the tab's client id, so client actions (`ui.navigate`, `ui.highlight`) are relayed back to the tab that asked.
- Agent: every action except `agent.*` becomes a tool; dots become double underscores.

## Bots and provenance

Each bot runs in `ctx.isolate('bot')`, so `ctx.bot` in a bot plugin is always that plugin's bot, and stopping a bot disposes only its subtree. Incoming messages become `MessageRecord`s with source `user`; outgoing ones get their source when sent:

- `session.send()` from middleware is attributed to the plugin that registered the middleware.
- Sending an `LlmResult` (from `ctx.llm.chat()`) records provider, model, latency and tokens.
- Any sender can pass an explicit `source`, which is how flows will report their node.

Records go to a 500-entry memory buffer per bot, a daily JSONL log in `data/messages/<bot>/`, and the `bots/message` event that the console forwards to dashboards.

## Agent

The Agent runs a tool loop over `ctx.llm.stream()`, up to 12 rounds per reply. Three rules keep its requests valid and cache-friendly:

- The system prompt never changes. Per-turn facts (current page, counts) go into the user message as a `<context>` note.
- The tool list is frozen when a conversation starts.
- Assistant turns are stored with the provider's raw content and replayed verbatim (append-only), which keeps Anthropic's preserved thinking valid.

Dangerous actions pause the loop until the user approves or declines in the dashboard (timeout 10 minutes). A tool call cut off by the output limit or a refusal is never run.

## Storage and security

- `mushin.config.json`: which app plugins load, with their config.
- `data/*.json`: providers, bots, Agent sessions, the admin token. Writes are atomic (temp file plus rename).
- API keys and adapter tokens are masked in every response; sending the masked value back keeps the stored secret.
- Every API call needs the admin token (`Authorization: Bearer`, or the first WebSocket message). The server binds to `127.0.0.1` by default.
- The token is stored in plain text, like the provider keys beside it, so the launcher can print a sign-in link on every start. It is printed to the terminal only, never through the logger, so neither the Logs page nor the Agent can read it. `mushin token reset` takes effect without a restart: a token that does not match makes the console re-read `data/auth.json`.
- Plugins run in-process with full access. There is no sandbox in the MVP.

## Tests

`pnpm test` runs unit tests and an end-to-end suite that boots a real instance against a mock NapCat (forward and reverse WebSocket) and a mock OpenAI-compatible server. It covers plugin loading, provider masking and tests, bot lifecycle and isolation, plugin provenance, LLM replies, local plugins, and Agent tool calls with navigation relay and approval.
