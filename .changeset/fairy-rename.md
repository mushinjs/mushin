---
"@mushinjs/plugin-fairy": minor
"@mushinjs/core": minor
"@mushinjs/dashboard": minor
"@mushinjs/plugin-console": minor
"@mushinjs/plugin-storage": minor
"@mushinjs/cli": minor
---

The Agent is now Fairy. `@mushinjs/plugin-agent` is renamed `@mushinjs/plugin-fairy`; its service is `ctx.fairy`, its actions are `fairy.*` (`fairy__*` over MCP), its events are `fairy/event` and `fairy/changed`, and it stores its data under `data/fairy/`. Actions opt out with `fairy: false`, a call from Fairy has caller kind `fairy`, and its log tag is `fairy`. Nothing is migrated: conversations, skills and settings saved by the Agent are not carried over, and a config that lists `@mushinjs/plugin-agent` must list `@mushinjs/plugin-fairy` instead.
