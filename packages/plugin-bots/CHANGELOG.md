# @mushinjs/plugin-bots

## 0.3.0

### Minor Changes

- 8ef908a: Every line in a bot's log written while a message is handled carries that message's record id, and `bots.logs` can narrow the lines to one message, a time range (also on earlier days), some text, or a level and above.
- 88a8c85: Plugin settings can be marked secret with `field(…, { secret: true })`. The plugin manager keeps their values in `.env` with a `${NAME}` reference in the config, for app plugins and bot plugins alike: keys saved from the dashboard move there right away, keys typed into `mushin.config.json` move on the next start, lists (and so the Agent and MCP tools) show them masked, and forms show a password input.

### Patch Changes

- Updated dependencies [70a7af1]
- Updated dependencies [88a8c85]
  - @mushinjs/core@0.3.0
  - @mushinjs/plugin-database@0.3.0
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
  - @mushinjs/plugin-database@0.2.0
