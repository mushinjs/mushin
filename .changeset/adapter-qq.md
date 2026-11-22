---
"@mushinjs/plugin-adapter-qq": minor
"@mushinjs/cli": minor
---

New QQ official bot adapter (`@mushinjs/plugin-adapter-qq`) for bots registered on the QQ Open Platform. It connects over the WebSocket gateway (resuming dropped sessions) or receives Ed25519-signed webhook events, and covers group and C2C chats, guild channels and guild DMs. Replies name the message they answer within QQ's five-minute window, pictures, voice, video and files are uploaded before sending, and non-message events such as `group_add_robot` reach flows by name. New instances load it by default.
