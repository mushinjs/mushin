# create-mushin

## 0.3.0

### Minor Changes

- 70a7af1: Mushin.js serves its actions over MCP at `/mcp`, for AI tools such as Claude Code. Requests need the admin token, and the tools follow the Agent's tool policy: tools turned off are not offered, and dangerous ones run only after the user approves them in the dashboard. A short list of tools is listed directly; `search_tools` and `call_tool` reach the rest. `mushin mcp` is a stdio bridge to it that reads the token from `.env`, and new apps (and `mushin upgrade`) get a `.mcp.json` that starts it.
- 51f6ffe: Four official skills for AI tools ship with the CLI: writing a plugin (starting with the questions to ask the user), building and testing flows, troubleshooting from logs and run records, and running the app (upgrades, backups, moving machines). New apps get them in `.claude/skills/`, `mushin upgrade` replaces them with the new version's, `mushin start` adds any that are missing, and `mushin skills` installs them on demand.

## 0.2.0

### Minor Changes

- 297dcae: `npm create mushin@next my-bot` (or `pnpm create mushin`) creates a Mushin.js app: a `package.json` with the Mushin.js packages, `AGENTS.md` for the AI you open in the folder, a `.gitignore` that keeps `.env`, `data/`, `cache/` and `logs/` out of git, and a `tsconfig.json` for local plugins. With pnpm it also writes the install-script settings pnpm needs.
  
  `mushin new plugin <name>` creates a TypeScript plugin in `plugins/<name>/` and turns it on. `mushin upgrade` updates the app's `@mushinjs` packages with its package manager (following `next` for a preview, `latest` otherwise, or `--tag`) and then moves the data to the new version's layout.
