---
name: mushin-troubleshoot
description: Find out why something in Mushin.js does not work, such as a bot that does not answer, a command or flow that does not fire, a plugin that failed or a wrong reply, from its logs and run records. Use when the user says something "doesn't work", "no reply", "not triggered" or "broken".
---

# Finding out why something does not work

Work from evidence. Every conclusion you give names the log line, run or check that shows it. Do not change anything until you know the cause, and change only what the cause needs.

Use the mushin MCP tools. Tools not listed directly run with `call_tool`.

## 1. Pin down the case

Get from the user, or from the records, the exact case: which bot, which chat (group id or private), what was sent, roughly when, and what they expected. If they don't know, find the message yourself: `bots__messages` with the bot id shows recent messages with their record ids, oldest first.

## 2. Is the bot up?

- `bots__get` shows the bot's status. Anything but `online` explains a silent bot.
- `bots__logs` shows the bot's own log, oldest first: connection events, adapter errors, plugin warnings, and why LLM chat skipped a message. Read it before you guess.
- Offline with the OneBot adapter usually means the OneBot 11 implementation (NapCat, Lagrange, LLOneBot, ...) is not running, the URL or port is wrong, or the token does not match. Quote the error line.

## 3. Did the message reach a flow?

For a message that should have started a flow or command:

1. `bots__logs` with `{ "id": "<bot id>", "message": "<record id>" }` gives only the lines written while that message was handled: when it arrived, what each plugin and flow said about it, and which plugin kept it from the ones after it (the `processed in …` line). Narrow other searches with `query` (text), `level` (`warn` for problems only), and `since` and `until` (ISO times) for older days.
2. `call_tool` with `flows.history` and `{ "bot": "<id>", "message": "<record id>" }` lists the runs that message started. No run means no trigger took it.
3. `call_tool` with `flows.route` and the same text (and `groupId` or `private` as in the real chat) shows, without sending anything, which triggers it reaches in order, which one keeps it, and which built-in commands and bot plugins still see it after. This is where you see a message caught by an earlier trigger.
4. `call_tool` with `flows.triggers` and the bot id lists every trigger in the order messages reach them, and which earlier trigger blocks each one. `flows.setTriggerOrder` changes the order, if the user agrees.
5. For a command, `call_tool` with `commands.list` shows who registered the name (a flow, a bot plugin, the built-in help) and names that two sources register on the same bot. `bots.tryCommand` shows how the text is read against a command's prefixes and arguments.
6. Permissions: `call_tool` with `permissions.check` tells whether that user passes a role check on the bot, and why not.

Also check the flow itself: `flows__get` shows whether it is enabled and which bots run it. A flow that is not on the bot never fires there.

## 4. Did the run go wrong?

When a run exists:

- `call_tool` with `flows.run` and the run id gives the full trace: every node with its inputs and outputs, the edges taken, replies, platform calls and the error.
- `flows__runs` with the flow id lists its recent runs.
- Find the first node whose output differs from what the user expected; that node, or the reference feeding it, is the cause.
- To check a fix, rerun the same message with `flows__test` before telling the user it works.

For an LLM reply that is wrong rather than missing, `call_tool` with `flows.preview` shows the exact messages the model gets (system rules, examples, history), without calling it.

## 5. A plugin that does not work

- `plugins__list` shows every app plugin with its status. `failed` comes with the error; `pending` means a service it needs is missing.
- `logs__recent` with tag `plugin` (or `system`) shows Mushin.js's own log lines.
- Bot plugins, and app plugins' chat commands, are switched per bot: `call_tool` with `bots.plugins.list` and the bot id. `projectOff` means the plugin is off for the whole project (the Plugins page), so it does not run even where the bot has it on.
- `call_tool` with `bots.runs` and the bot id lists what plugins did with its messages: replied, kept the message from the plugins after it, or failed (with the error). Flows have their own runs in `flows.history`.

## 6. Report

Tell the user in a few sentences:

1. What happened, quoting the log line or run step that shows it (with its time, or the run id).
2. Why.
3. The fix: what you would change, or what they need to do (for example in their OneBot implementation). Make the change once they agree, then test it again the same way you found the problem.
