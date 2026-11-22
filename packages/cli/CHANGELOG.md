# @mushinjs/cli

## 0.3.0

### Minor Changes

- 70a7af1: Mushin.js serves its actions over MCP at `/mcp`, for AI tools such as Claude Code. Requests need the admin token, and the tools follow the Agent's tool policy: tools turned off are not offered, and dangerous ones run only after the user approves them in the dashboard. A short list of tools is listed directly; `search_tools` and `call_tool` reach the rest. `mushin mcp` is a stdio bridge to it that reads the token from `.env`, and new apps (and `mushin upgrade`) get a `.mcp.json` that starts it.
- 51f6ffe: Four official skills for AI tools ship with the CLI: writing a plugin (starting with the questions to ask the user), building and testing flows, troubleshooting from logs and run records, and running the app (upgrades, backups, moving machines). New apps get them in `.claude/skills/`, `mushin upgrade` replaces them with the new version's, `mushin start` adds any that are missing, and `mushin skills` installs them on demand.

### Patch Changes

- 88a8c85: Plugin settings can be marked secret with `field(…, { secret: true })`. The plugin manager keeps their values in `.env` with a `${NAME}` reference in the config, for app plugins and bot plugins alike: keys saved from the dashboard move there right away, keys typed into `mushin.config.json` move on the next start, lists (and so the Agent and MCP tools) show them masked, and forms show a password input.
- Updated dependencies [5952012]
- Updated dependencies [8b89584]
- Updated dependencies [4015d84]
- Updated dependencies [afbb235]
- Updated dependencies [c31a9a8]
- Updated dependencies [8ef908a]
- Updated dependencies [70a7af1]
- Updated dependencies [51f6ffe]
- Updated dependencies [ccbd24d]
- Updated dependencies [efb9f23]
- Updated dependencies [e4f7ee8]
- Updated dependencies [88a8c85]
  - @mushinjs/plugin-agent@0.3.0
  - @mushinjs/plugin-providers@0.3.0
  - @mushinjs/plugin-provider-openai@0.3.0
  - @mushinjs/plugin-provider-gemini@0.3.0
  - @mushinjs/plugin-provider-anthropic@0.3.0
  - @mushinjs/plugin-bots@0.3.0
  - @mushinjs/plugin-console@0.3.0
  - @mushinjs/core@0.3.0
  - @mushinjs/plugin-knowledge@0.3.0
  - @mushinjs/bot-plugin-companion@0.3.0
  - @mushinjs/bot-plugin-llm-chat@0.3.0
  - @mushinjs/plugin-demo@0.3.0
  - @mushinjs/plugin-flows@0.3.0
  - @mushinjs/plugin-provider-typesafe@0.3.0
  - @mushinjs/plugin-stats@0.3.0
  - @mushinjs/bot-plugin-echo@0.3.0
  - @mushinjs/bot-plugin-flows@0.3.0
  - @mushinjs/plugin-adapter-onebot@0.3.0
  - @mushinjs/plugin-permissions@0.3.0
  - @mushinjs/plugin-personas@0.3.0
  - @mushinjs/plugin-database@0.3.0
  - @mushinjs/plugin-mcp@0.3.0
  - @mushinjs/plugin-storage@0.3.0
  - @mushinjs/plugin-terminal@0.3.0

## 0.2.0

### Minor Changes

- 7acde79: The instance folder has a new layout: `data/` holds `core/`, `bots/<id>/`, `agents/` and `plugins/<name>/` beside `mushin.db`, and bot logs move to `logs/`, which is safe to delete, as is `cache/`. Storage keys are unchanged, so plugins need no changes.
  
  `mushin start` moves an older instance to the new layout after copying its `data/` folder to `data/backups/`. `mushin migrate [--dry-run]` does the same without starting. Running it again changes nothing.
- 10df5af: Packages are published as compiled JavaScript with type declarations. `mushin start` from an npm install no longer loads tsx; it starts tsx only when the instance's `plugins/` folder holds a TypeScript plugin.
  
  The packages are published under the `@mushinjs` scope. An instance that saved `@mushin/...` package names in `mushin.config.json` or in its bots is read with the new names and saved back.
- 297dcae: `npm create mushin@next my-bot` (or `pnpm create mushin`) creates a Mushin.js app: a `package.json` with the Mushin.js packages, `AGENTS.md` for the AI you open in the folder, a `.gitignore` that keeps `.env`, `data/`, `cache/` and `logs/` out of git, and a `tsconfig.json` for local plugins. With pnpm it also writes the install-script settings pnpm needs.
  
  `mushin new plugin <name>` creates a TypeScript plugin in `plugins/<name>/` and turns it on. `mushin upgrade` updates the app's `@mushinjs` packages with its package manager (following `next` for a preview, `latest` otherwise, or `--tag`) and then moves the data to the new version's layout.
- a43ed0d: Secrets move to the instance's `.env` file. The admin token is `MUSHIN_ADMIN_TOKEN` there; provider keys, adapter secrets (such as the OneBot token) and MCP environment values and headers are written to `.env` when saved, and the records in `data/` hold `${NAME}` references. Plugin settings in `mushin.config.json` can use `${NAME}` too. A variable set in the environment overrides `.env`. Keys an older version kept in plain text move to `.env` on the next start.
  
  `resetAdminToken` and `readAdminToken` take the instance folder instead of the data folder.

### Patch Changes

- Updated dependencies [7acde79]
- Updated dependencies [5f8b920]
- Updated dependencies [a43ed0d]
  - @mushinjs/plugin-storage@0.2.0
  - @mushinjs/plugin-demo@0.2.0
  - @mushinjs/core@0.2.0
  - @mushinjs/plugin-console@0.2.0
  - @mushinjs/plugin-providers@0.2.0
  - @mushinjs/plugin-bots@0.2.0
  - @mushinjs/plugin-mcp@0.2.0
  - @mushinjs/bot-plugin-llm-chat@0.2.0
  - @mushinjs/plugin-agent@0.2.0
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
