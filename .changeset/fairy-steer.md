---
"@mushinjs/plugin-fairy": minor
"@mushinjs/dashboard": minor
---

You can write to Fairy while it works. Press Enter as usual: the message shows under what Fairy is doing, marked "Fairy reads this before its next step", and Fairy reads it once the current step is done, without stopping what is running. It can change course, answer a question or add what you asked, and when you tell it to stop ("不做了", "stop"), it ends with a short note on what is done. A message that comes in just as a reply ends still gets its answer. A message sent while Fairy waits for your approval declines that action, and one sent while it waits for an answer to its question replaces the answer. A helper at work gets the message too, and Fairy reads it after the helper reports. The stop button still stops at once.

`fairy.send` to a conversation with a turn running no longer fails with `conflict`: it adds the message to the turn and returns `{ session, queued }` at once (editing a message while it runs still fails). New `fairy/event` types: `queued` when such a message comes in, `delivered` when Fairy or a helper has read it.
