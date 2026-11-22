---
"@mushinjs/plugin-adapter-telegram": minor
"@mushinjs/dashboard": patch
"@mushinjs/cli": minor
---

New Telegram adapter (`@mushinjs/plugin-adapter-telegram`). It receives updates by long polling or through a webhook it registers itself (checked with a secret token derived from the bot token), and takes a custom API address for a self-hosted Bot API server or a reverse proxy. Mentions of the bot and `/command@Bot` are read as Mushin mentions and commands, answers stay in the forum topic they answer, pictures, voice, video and files go by address, `file_id` or upload, group roles come from `getChatMember`, and member changes, join requests and button presses reach flows as events. New instances load it by default.
