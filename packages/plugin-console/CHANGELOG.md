# @mushinjs/plugin-console

## 0.3.0

### Minor Changes

- 70a7af1: Mushin.js serves its actions over MCP at `/mcp`, for AI tools such as Claude Code. Requests need the admin token, and the tools follow the Agent's tool policy: tools turned off are not offered, and dangerous ones run only after the user approves them in the dashboard. A short list of tools is listed directly; `search_tools` and `call_tool` reach the rest. `mushin mcp` is a stdio bridge to it that reads the token from `.env`, and new apps (and `mushin upgrade`) get a `.mcp.json` that starts it.

### Patch Changes

- 51f6ffe: Four official skills for AI tools ship with the CLI: writing a plugin (starting with the questions to ask the user), building and testing flows, troubleshooting from logs and run records, and running the app (upgrades, backups, moving machines). New apps get them in `.claude/skills/`, `mushin upgrade` replaces them with the new version's, `mushin start` adds any that are missing, and `mushin skills` installs them on demand.
- Updated dependencies [5952012]
- Updated dependencies [8b89584]
- Updated dependencies [4015d84]
- Updated dependencies [afbb235]
- Updated dependencies [c31a9a8]
- Updated dependencies [8ef908a]
- Updated dependencies [70a7af1]
- Updated dependencies [e4f7ee8]
- Updated dependencies [88a8c85]
  - @mushinjs/plugin-agent@0.3.0
  - @mushinjs/plugin-providers@0.3.0
  - @mushinjs/dashboard@0.3.0
  - @mushinjs/plugin-bots@0.3.0
  - @mushinjs/core@0.3.0
  - @mushinjs/plugin-flows@0.3.0
  - @mushinjs/plugin-stats@0.3.0
  - @mushinjs/plugin-storage@0.3.0

## 0.2.0

### Minor Changes

- a43ed0d: Secrets move to the instance's `.env` file. The admin token is `MUSHIN_ADMIN_TOKEN` there; provider keys, adapter secrets (such as the OneBot token) and MCP environment values and headers are written to `.env` when saved, and the records in `data/` hold `${NAME}` references. Plugin settings in `mushin.config.json` can use `${NAME}` too. A variable set in the environment overrides `.env`. Keys an older version kept in plain text move to `.env` on the next start.
  
  `resetAdminToken` and `readAdminToken` take the instance folder instead of the data folder.

### Patch Changes

- Updated dependencies [7acde79]
- Updated dependencies [a43ed0d]
  - @mushinjs/plugin-storage@0.2.0
  - @mushinjs/core@0.2.0
  - @mushinjs/plugin-providers@0.2.0
  - @mushinjs/plugin-bots@0.2.0
  - @mushinjs/plugin-agent@0.2.0
  - @mushinjs/plugin-flows@0.2.0
  - @mushinjs/plugin-stats@0.2.0
  - @mushinjs/dashboard@0.2.0
