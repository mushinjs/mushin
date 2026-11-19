---
name: mushin-plugin-dev
description: Write or change a local Mushin.js plugin in plugins/ (TypeScript, no build step). Use when the user asks for a new feature, command, scheduled job or integration for their QQ bot that a conversation flow cannot do well.
---

# Writing a Mushin.js plugin

A plugin is a package in `plugins/<name>/` that Mushin.js runs as TypeScript. It exports `name`, optionally `inject` and `Config` (a zod schema), and `apply(ctx, config)`. Everything comes from `@mushinjs/core`.

Before writing a plugin, check whether a flow does the job: replies to commands or keywords, branches, LLM answers, schedules and tables are all flow nodes (see the `mushin-flows` skill). Write a plugin when the job needs code: an outside API with its own logic, data processing, or something no node type covers.

## 1. Ask before you write

Ask the user these questions, in their language, all in one message. Skip the ones their request already answers. Never guess a group id, a time, a city or an API.

1. **What starts it?** A command such as `/weather`, a keyword, a schedule (what time, which days, which timezone), or an event such as someone joining a group.
2. **Where does it act?** Which bot (list them with `bots__list`) and which groups or private chats. Offer the groups the bots have seen (`call_tool` with `bots.groupChoices`).
3. **What does it send or do?** The exact content and format, and an example of a good reply.
4. **Where does the data come from?** The service or API, whether it needs a key, and limits such as rate or cost.
5. **Who may use it?** Everyone, group admins, or only the bot's master.
6. **What should happen when it fails?** Stay silent, reply with an error, or tell the master.
7. **Which behaviors are optional?** Each one becomes a switch in the settings (see below).

Then say in two or three sentences what you will build, and wait for a yes.

## 2. Create it

Run `npx mushin new plugin <name>` in the app folder (lowercase letters, digits and dashes). It writes `plugins/<name>/package.json` and `src/index.ts`, and turns the plugin on in `mushin.config.json`. Read the generated `src/index.ts` first: it shows the shape of a plugin with one action.

## 3. Rules for the code

**Settings.** Every value the user may want to change is a field in `Config`, never a constant in the code: groups, times, cities, prompts, limits.

- Give each field a title and description with `field()`, in English and Chinese:
  ```ts
  city: z.string().default('Shanghai').meta(field('City', 'The city whose weather is sent', {
    'zh-CN': { title: '城市', description: '要发送天气的城市' },
  })),
  ```
- Every optional behavior is a boolean with a sensible default, so the user can turn it on or off on the dashboard's Plugins page: `mentionAll: z.boolean().default(false)`.
- Ids come with choices so the form offers a list: `field('Group', undefined, {}, { choices: 'bots.groupChoices' })`.
- Read the settings with `Config.parse(raw ?? {})` at the start of `apply`.

**Secrets.** An API key or token is a field marked secret, never a default value and never in the code:

```ts
apiKey: z.string().default('').meta(field('API key', 'Key of the weather service', {
  'zh-CN': { title: 'API 密钥', description: '天气服务的密钥' },
}, { secret: true })),
```

When the user types the key into the plugin's form on the dashboard's Plugins page, Mushin.js puts it into `.env` and the config keeps a reference such as `${WEATHER_API_KEY}`; lists show it masked, and `apply` gets the real value. Ask the user to enter the key there (or to add `NAME=value` to `.env` and write `${NAME}` in the setting). Never ask them to paste a key into the chat, and never read, print or copy `.env`. Check in `apply` that the key is set, and log a warning that names the setting when it is empty.

**Services.** List what the plugin uses in `inject`; it starts once they are all there.

- `actions`: `ctx.actions.define({ name, description, risk, input, handler })`. Name it `<camelName>.<verb>`. Risk is `read`, `write` or `dangerous`. The description is written for an AI: what it does and what it returns.
- `bots`: `ctx.bots.get(botId)` is a running bot. `bot.send({ type: 'group', id: groupId }, 'text')` sends a message. Check that the bot exists and is online, and log a warning when it is not.
- `storage`: `ctx.storage.get(key)` and `ctx.storage.set(key, value)`. Start every key with the plugin's name (`weather/last-sent`), and the data lands in `data/plugins/<name>/`. Do not write files under `data/` yourself.
- `ctx.logger('<name>')` for logs. Log what happened and why it was skipped; never log a secret.

**Cleanup.** Anything that keeps running is wrapped in `ctx.effect`, so it stops when the plugin is turned off or reloaded:

```ts
ctx.effect(() => {
  const timer = setInterval(tick, 60_000)
  return () => clearInterval(timer)
})
```

For a daily job, check once a minute whether the configured time (in the configured timezone) has passed and the job has not run today. Store the last run date with `ctx.storage`, so a restart does not send twice.

**A way to run it now.** A scheduled or event-driven plugin also defines an action such as `weather.sendNow` that runs the job once. You test it with that action, and the user can call it from the dashboard.

**Keep it small.** One plugin, one job. Use `fetch` for HTTP. Add a package to the app only when it saves real work, and tell the user why.

## 4. Check it

1. `npm run typecheck` (or `pnpm run typecheck`) passes.
2. Reload the plugin: `plugins__list` shows its entry id; run `call_tool` with `plugins.reload` and `{ "id": "<entry id>" }`, or ask the user to restart Mushin.js. `plugins__list` must then show it `active`. If it shows `failed`, read the error and `logs__recent` with tag `plugin`.
3. Try it without touching real groups. Use the sandbox bot of the Demo plugin when there is one (`plugins__list`, then `bots__sandbox` to write as its test user, and `bots__messages` to read the reply). Call your `…Now` action against the sandbox bot. A command can also be checked with `bots.commands.run` without a target, which only previews it.
4. Turn each switch off and on once (`plugins.configure`) and check that the behavior follows it.
5. Tell the user what you built, which settings it has, what goes into `.env`, and how to try it for real.
