---
"@mushinjs/plugin-adapter-kook": minor
"@mushinjs/dashboard": patch
"@mushinjs/cli": minor
---

New KOOK adapter (`@mushinjs/plugin-adapter-kook`). It connects over WebSocket (pinging, and resuming from the last event after a drop) or takes webhook events, answering KOOK's address check, checking the Verify Token, and reading compressed and encrypted bodies. Channel messages are group chats and direct messages private chats; KMarkdown mentions and quotes go both ways, pictures, video, voice and files are uploaded as KOOK assets, server owners and administrator roles count as group owner and admin, the bot's text channels are its contacts, and system events such as `joined_guild` reach flows by name. New instances load it by default.
