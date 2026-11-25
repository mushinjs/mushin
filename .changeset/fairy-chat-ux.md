---
"@mushinjs/dashboard": minor
"@mushinjs/ui": minor
"@mushinjs/plugin-fairy": patch
---

Fairy's chat reads more cleanly. Fairy's replies sit in the conversation as plain text and only your own messages are bubbles; on a wide screen the conversation stays in a centered column. The input is one rounded box that holds the text, the model picker and the send button, and grows with the text instead of showing a drag handle. A suggestion you click goes into the input, with its skill, so you can edit it before sending. The dock's header has one history button, one new-chat button and a menu with delete, which now asks first; in the workspace the conversation header shows its title, and new, history and delete live in the sessions column, where delete asks first too. `/clear` is gone, since `/new` does the same.

`Input` takes `bordered: false` for a field inside a box that draws its own border, and an autosized textarea no longer has a resize handle or extra height below its last line.
