# @mushinjs/cli

## 0.2.0

### Minor Changes

- 7acde79: The instance folder has a new layout: `data/` holds `core/`, `bots/<id>/`, `agents/` and `plugins/<name>/` beside `mushin.db`, and bot logs move to `logs/`, which is safe to delete, as is `cache/`. Storage keys are unchanged, so plugins need no changes.
  
  `mushin start` moves an older instance to the new layout after copying its `data/` folder to `data/backups/`. `mushin migrate [--dry-run]` does the same without starting. Running it again changes nothing.
- 10df5af: Packages are published as compiled JavaScript with type declarations. `mushin start` from an npm install no longer loads tsx; it starts tsx only when the instance's `plugins/` folder holds a TypeScript plugin.
  
  The packages are published under the `@mushinjs` scope. An instance that saved `@mushin/...` package names in `mushin.config.json` or in its bots is read with the new names and saved back.
- a43ed0d: Secrets move to the instance's `.env` file. The admin token is `MUSHIN_ADMIN_TOKEN` there; provider keys, adapter secrets (such as the OneBot token) and MCP environment values and headers are written to `.env` when saved, and the records in `data/` hold `${NAME}` references. Plugin settings in `mushin.config.json` can use `${NAME}` too. A variable set in the environment overrides `.env`. Keys an older version kept in plain text move to `.env` on the next start.
  
  `resetAdminToken` and `readAdminToken` take the instance folder instead of the data folder.

### Patch Changes

- Updated dependencies [7acde79]
- Updated dependencies [a43ed0d]
  - @mushinjs/plugin-storage@0.2.0
  - @mushinjs/core@0.2.0
  - @mushinjs/plugin-console@0.2.0
  - @mushinjs/plugin-providers@0.2.0
  - @mushinjs/plugin-bots@0.2.0
  - @mushinjs/plugin-mcp@0.2.0
  - @mushinjs/bot-plugin-llm-chat@0.2.0
  - @mushinjs/plugin-agent@0.2.0
  - @mushinjs/plugin-demo@0.2.0
  - @mushinjs/plugin-flows@0.2.0
  - @mushinjs/plugin-knowledge@0.2.0
  - @mushinjs/plugin-permissions@0.2.0
  - @mushinjs/plugin-personas@0.2.0
  - @mushinjs/plugin-stats@0.2.0
  - @mushinjs/plugin-terminal@0.2.0
  - @mushinjs/bot-plugin-companion@0.2.0
  - @mushinjs/bot-plugin-echo@0.2.0
  - @mushinjs/bot-plugin-flows@0.2.0
  - @mushinjs/plugin-adapter-onebot@0.2.0
  - @mushinjs/plugin-database@0.2.0
  - @mushinjs/plugin-provider-anthropic@0.2.0
  - @mushinjs/plugin-provider-gemini@0.2.0
  - @mushinjs/plugin-provider-openai@0.2.0
  - @mushinjs/plugin-provider-typesafe@0.2.0
