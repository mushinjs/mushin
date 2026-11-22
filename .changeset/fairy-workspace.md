---
"@mushinjs/plugin-fairy": minor
"@mushinjs/plugin-console": minor
"@mushinjs/plugin-storage": patch
"@mushinjs/dashboard": minor
---

Fairy has a workspace at `/fairy`: conversations on the left, the chat in the middle and a panel on the right, with both sides hidden or resized by dragging. Conversations are filed into groups by the first thing they work on (a bot, a plugin, a flow, a provider), named after it, and a conversation that started a helper is filed under what the helper worked on. Groups can be renamed, created and deleted, and conversations moved between them, renamed or marked done, from the list or by dragging (`fairy.groups.*`, `fairy.sessions.update`). The panel shows the status of bots, app plugins, flow runs and running conversations, any dashboard page and web pages in tabs; Fairy opens tabs there with the new `ui.panel` client action, and `ui.navigate` opens pages there while the workspace is open. Drag a conversation onto the middle, or use the split button, to show two conversations side by side.
