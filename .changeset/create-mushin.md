---
"create-mushin": minor
"@mushinjs/cli": minor
---

`npm create mushin@next my-bot` (or `pnpm create mushin`) creates a Mushin.js app: a `package.json` with the Mushin.js packages, `AGENTS.md` for the AI you open in the folder, a `.gitignore` that keeps `.env`, `data/`, `cache/` and `logs/` out of git, and a `tsconfig.json` for local plugins. With pnpm it also writes the install-script settings pnpm needs.

`mushin new plugin <name>` creates a TypeScript plugin in `plugins/<name>/` and turns it on. `mushin upgrade` updates the app's `@mushinjs` packages with its package manager (following `next` for a preview, `latest` otherwise, or `--tag`) and then moves the data to the new version's layout.
