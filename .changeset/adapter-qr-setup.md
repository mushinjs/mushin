---
"@mushinjs/plugin-bots": minor
"@mushinjs/plugin-adapter-qq": minor
"@mushinjs/plugin-adapter-telegram": patch
"@mushinjs/plugin-adapter-discord": patch
"@mushinjs/plugin-adapter-kook": patch
"@mushinjs/dashboard": minor
---

A QQ official bot can be created by scanning a QR code with mobile QQ when adding it: the QQ Open Platform creates the bot under the scanning account and Mushin fills in its AppID and AppSecret (`qq.bindStart` and `qq.bindPoll`). Adapters can offer such a scan with `qrSetup`, list setup pages with `links` (the developer portal, @BotFather), and give each bot an address that adds it to a chat with `bot.setInvite()`; the bot's Connection page shows it as a link and a QR code. Telegram bots get a link that opens Telegram to pick a group, and Discord bots an OAuth2 invite to a server.
