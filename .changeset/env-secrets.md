---
"@mushinjs/core": minor
"@mushinjs/cli": minor
"@mushinjs/plugin-storage": minor
"@mushinjs/plugin-console": minor
"@mushinjs/plugin-providers": minor
"@mushinjs/plugin-bots": minor
"@mushinjs/plugin-mcp": minor
---

Secrets move to the instance's `.env` file. The admin token is `MUSHIN_ADMIN_TOKEN` there; provider keys, adapter secrets (such as the OneBot token) and MCP environment values and headers are written to `.env` when saved, and the records in `data/` hold `${NAME}` references. Plugin settings in `mushin.config.json` can use `${NAME}` too. A variable set in the environment overrides `.env`. Keys an older version kept in plain text move to `.env` on the next start.

`resetAdminToken` and `readAdminToken` take the instance folder instead of the data folder.
