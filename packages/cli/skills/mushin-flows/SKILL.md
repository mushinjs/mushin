---
name: mushin-flows
description: Build, change or test a Mushin.js conversation flow (keyword or command replies, branches, LLM answers, schedules, waiting for a reply) through the mushin MCP tools. Use when the user wants their bot to answer or do something in chats.
---

# Building a conversation flow

A flow is a graph of nodes that a bot runs when a message, event or schedule reaches one of its trigger nodes. Flows are data: you create and change them with the mushin MCP tools, never by editing files under `data/`.

## 1. Find out what to build

You need to know:

- **The bot or bots** it runs on. Get the ids from `bots__list`; never invent one.
- **What starts it**: a command (`/checkin`), a keyword or pattern, an @-mention, an event (someone joins, a poke), or a schedule.
- **What it does**, including the exact reply text and what happens in each branch.
- **Who may trigger it** and **where**: all chats, some groups, private chats only.

Ask the user, in one message, for whatever the request leaves open. Then look at what exists:

- `flows__list`: a flow may already do part of this. Change that one instead of adding a second that competes for the same messages.
- `call_tool` with `commands.list`: the commands each bot already answers. Do not reuse a name.

## 2. Pick the node types

1. `flows__nodeTypes` with no input lists every type in one line each.
2. `flows__nodeTypes` with `{ "types": [ ...the ids you plan to use ] }` gives their config schemas, ports, exec outputs and a worked example. Read it before you write the nodes.

Use only type ids that list shows. If nothing does what the user wants, say so and offer the closest way (or a plugin, see the `mushin-plugin-dev` skill). Types marked restricted, such as terminal commands, can only be added by the user in the flow editor.

## 3. Write the flow

`flows__create` with `name`, `bots`, `nodes` and `edges`:

- Every flow starts at a trigger node.
- Edges only say what runs next: from a node's `exec:<output>` handle (`exec:next`, `exec:true`, `exec:other`…) to the next node's `exec` handle.
- Values move by reference, not along edges: set an input (or text in a config) to `{{<node id>.<output>}}` of a node that ran before, or `{{sys.text}}` for the message text.
- Give nodes short readable ids (`trigger`, `reply-ok`), so references stay clear.

The result lists validation issues. Fix every one with `flows__update` before you go on.

## 4. Test it

`flows__test` sends a made-up message through the flow. Nothing reaches a chat and no platform API is called, but LLM nodes do call the model.

- Test each branch: a message that should match, one that should not, and the edge cases (empty arguments, a user without permission with `role`, a group with `groupId`, a private chat with `private: true`).
- Event triggers: pass `event` instead of `text`. Schedules: pass `schedule` with the trigger node id.
- `wait for reply` nodes: pass the answers in `replies`.
- Read the path, each step's outputs and the replies. If something is off, `flows__update` and test again.
- Check that it does not steal messages from other flows: `call_tool` with `flows.route` and a message shows every trigger it would reach, in order, and what still sees it after. `flows.triggers` shows the order on a bot, and `flows.setTriggerOrder` changes it.

Save the cases that matter as test cases (`call_tool` with `flows.tests.create`) so they run again after later changes. `flows.tests.run` runs them.

## 5. Hand it over

Tell the user what the flow does, which bots run it, how to try it in a chat, and which cases you tested. If the flow has an LLM node, say which provider it uses. When the dashboard is open, the flow is at `/flows/<flow id>`.
