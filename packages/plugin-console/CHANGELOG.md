# @mushinjs/plugin-console

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
