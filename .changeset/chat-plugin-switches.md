---
'@mushinjs/core': minor
'@mushinjs/plugin-bots': minor
'@mushinjs/plugin-flows': minor
'@mushinjs/bot-plugin-flows': minor
'@mushinjs/plugin-console': minor
'@mushinjs/plugin-fairy': minor
'@mushinjs/dashboard': minor
'@mushinjs/cli': minor
---

Plugins that answer in chats have a project switch and a switch on each bot. An app plugin's chat commands (`bots.defineCommand` without `bots`) answer only on the bots it is turned on for, from the bot's Plugins tab or `bots.plugins.enable`; bot plugins get a project switch on the Plugins page (`bots.plugins.setProject`). A bot's Runs tab now lists plugin runs beside flow runs: each message a plugin replied to, kept from the plugins after it, or failed on (`bots.runs`), with the log lines written meanwhile. The Plugins page shows how many commands, flow nodes, tools and adapters each running plugin adds, with the names on hover (`plugins.provides`).
