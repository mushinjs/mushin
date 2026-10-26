# Architecture (as built)

The full design, including the plugin marketplace, lives in the design document *Mushin.js — Architecture & MVP Design*. This page records how the MVP implements it.

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
│       └── enabled bot plugins (the flows runner among them)
├── flows                @mushin/plugin-flows       node types, flow documents, engine
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
- Any sender can pass an explicit `source`, which is how flows report the flow and node that replied (plus the provider and model when an LLM node wrote the text).

Records go to a 500-entry memory buffer per bot, a daily JSONL log in `data/messages/<bot>/`, and the `bots/message` event that the console forwards to dashboards. With the database plugin running they also go to the `bots_message` table, and `bots.messages` reads a chat's history and older pages (`before`) from there. The first time the table exists, the JSONL logs are imported; after that, only lines newer than the newest stored message of each bot (written while the database plugin was off). The JSONL files are never removed.

## Flows

A flow is a JSON document (`flows/<id>` in storage) with nodes, edges and the bots that run it. Every node has a type from the registry that `@mushin/plugin-flows` keeps (`ctx.flows.defineNode()`); the built-in types live in `packages/plugin-flows/src/nodes.ts`. A type is one of two kinds:

| Kind | Ports | Runs |
| --- | --- | --- |
| `trigger` | One exec output, outputs | `match()` on every incoming message; a match starts a run |
| `action` | One exec input, named exec outputs, inputs and outputs | When execution reaches it; returns which exec output to follow |

Edges are control flow only: from an exec output `exec:<name>` to a node's exec input `exec`. Values move by reference (`src/refs.ts`): a node's `inputs` map each input to a string such as `{{n1.rest}}`, and strings in its config may contain references too. `{{<node id>.<output>}}` reads a node that already ran in this run, `{{sys.<name>}}` the incoming message, and `{{chat|user|flow|run.<name>}}` a stored variable. A string that is exactly one reference keeps the value's type; otherwise references are filled in as text. Inputs are then converted to their declared type (`text`, `number`, `boolean`, `message` or `any`). Documents saved with the older `out:<port>` → `in:<port>` data edges are converted when loaded or saved: each edge becomes a reference, and nodes that only fed data are spliced into the execution path before their first reader.

`compile()` (`src/graph.ts`) checks a document whenever it is saved or run and reports issues: unknown types, config that fails the type's schema, edges to missing nodes or ports, references to missing nodes or outputs, missing triggers, and nodes no trigger reaches. A flow with errors is saved but does not run. `classify`-style nodes get their exec outputs from config (`execOutFrom`), and the dashboard computes ports the same way.

At run time `@mushin/bot-plugin-flows` registers middleware with priority 10, ahead of plugins such as LLM chat. It hands each message to `ctx.flows.dispatch()`, which runs every flow attached to the bot whose trigger matches. A matching trigger consumes the message unless its `passThrough` option is on; only unconsumed messages reach the next middleware. A run is stopped after 200 steps or 60 seconds. Each run produces a trace (nodes visited with timings, inputs and outputs, edges taken, replies, error), kept in memory for the last 20 runs per flow and sent as the `flows/run` event, which the editor uses to highlight live paths. `flows.test` runs a made-up message through the same engine with a session whose `send` only records the text; with `nodeId` it stops after that node, which is how the editor executes one step.

Variables have four scopes: `run` (this message), `chat`, `user` and `flow` (all three per bot). Nodes read them from memory; with the database plugin running, `chat`, `user` and `flow` variables are loaded from the `flows_var` table at startup and saved a second after they change, so they survive restarts. Deleting a flow deletes its variables. Test runs use the bot id `test`, whose variables are never saved.

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

`pnpm test` runs unit tests and an end-to-end suite that boots a real instance against a mock NapCat (forward and reverse WebSocket) and a mock OpenAI-compatible server. It covers plugin loading, provider masking and tests, bot lifecycle and isolation, plugin provenance, LLM replies, local plugins, Agent tool calls with navigation relay and approval, and flows running on a bot end to end. The flow engine and validator have their own unit tests in `packages/plugin-flows/tests`.
