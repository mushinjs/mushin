---
"@mushinjs/plugin-adapter-discord": minor
"@mushinjs/dashboard": patch
"@mushinjs/cli": minor
---

New Discord adapter (`@mushinjs/plugin-adapter-discord`). It connects through the gateway with heartbeats and session resumes, and explains in the bot's status when Discord refuses the token or a privileged intent. Guild channels are group chats and DMs are private chats with the person; mentions, replies, pictures (as embeds) and uploaded files go both ways, long text is split at 2000 characters, the server owner and Administrator roles count as group owner and admin, and the bot's text channels are its contacts. Other gateway events reach flows by name, such as `guild_member_add`. New instances load it by default.
