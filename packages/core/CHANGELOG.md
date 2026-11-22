# @mushinjs/core

## 0.3.0

### Minor Changes

- 70a7af1: Mushin.js serves its actions over MCP at `/mcp`, for AI tools such as Claude Code. Requests need the admin token, and the tools follow the Agent's tool policy: tools turned off are not offered, and dangerous ones run only after the user approves them in the dashboard. A short list of tools is listed directly; `search_tools` and `call_tool` reach the rest. `mushin mcp` is a stdio bridge to it that reads the token from `.env`, and new apps (and `mushin upgrade`) get a `.mcp.json` that starts it.
- 88a8c85: Plugin settings can be marked secret with `field(…, { secret: true })`. The plugin manager keeps their values in `.env` with a `${NAME}` reference in the config, for app plugins and bot plugins alike: keys saved from the dashboard move there right away, keys typed into `mushin.config.json` move on the next start, lists (and so the Agent and MCP tools) show them masked, and forms show a password input.

## 0.2.0

### Minor Changes

- a43ed0d: Secrets move to the instance's `.env` file. The admin token is `MUSHIN_ADMIN_TOKEN` there; provider keys, adapter secrets (such as the OneBot token) and MCP environment values and headers are written to `.env` when saved, and the records in `data/` hold `${NAME}` references. Plugin settings in `mushin.config.json` can use `${NAME}` too. A variable set in the environment overrides `.env`. Keys an older version kept in plain text move to `.env` on the next start.
  
  `resetAdminToken` and `readAdminToken` take the instance folder instead of the data folder.
