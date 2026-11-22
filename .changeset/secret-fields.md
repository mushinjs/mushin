---
"@mushinjs/core": minor
"@mushinjs/plugin-bots": minor
"@mushinjs/dashboard": patch
"@mushinjs/cli": patch
---

Plugin settings can be marked secret with `field(…, { secret: true })`. The plugin manager keeps their values in `.env` with a `${NAME}` reference in the config, for app plugins and bot plugins alike: keys saved from the dashboard move there right away, keys typed into `mushin.config.json` move on the next start, lists (and so Fairy and MCP tools) show them masked, and forms show a password input.
