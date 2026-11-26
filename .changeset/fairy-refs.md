---
"@mushinjs/plugin-fairy": minor
"@mushinjs/dashboard": minor
---

Attach things to a Fairy message for it to read: type `@` in the input to pick a bot, plugin or flow, or drag a bot card, a flow, a run or selected log lines into the input (from the console, the floating window or a page in the workspace's panel; with Fairy closed, hold the drag over its button to open it). Each becomes a chip that shows what it is on hover and stays on the sent message. `fairy.send` takes `refs` and gives the model what each one is now, read the way Fairy's own tools read it: a bot's status, a flow's nodes, a run's steps, the log lines. Quoting a chat message to Fairy is one of these now. Log lines selected on a log page have an "Ask Fairy" button too. Editing or retrying a sent message keeps its skills and attachments; the edit box shows them, and you can take any off. `fairy.send` with `rewind` keeps them too unless `skills` or `refs` are given.
