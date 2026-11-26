---
name: mushin-operations
description: Run a Mushin.js app day to day, including upgrading Mushin.js, backing up and restoring its data, moving it to another machine, migrating an old data folder and resetting the admin token. Use when the user asks to update, back up, restore, move or recover their bot.
---

# Running a Mushin.js app

The app folder holds everything. Know what each part is before touching it:

| Path | What it is |
| --- | --- |
| `package.json`, `node_modules/` | The Mushin.js packages. `node_modules/` can always be installed again. |
| `mushin.config.json` | Which plugins run and their settings. No secrets. |
| `.env` | Secrets: the admin token, provider keys, bot tokens. Never print, copy or commit it. |
| `plugins/`, `skills/` | The user's own plugins and skills. |
| `data/` | Everything Mushin.js keeps: `mushin.db`, bots, providers, flows, message logs. |
| `logs/`, `cache/` | Safe to delete. |

Never edit files under `data/` by hand while Mushin.js runs, and never delete anything under `data/` without a backup and the user's yes.

Use `npm` or `pnpm`, whichever the app uses: a `pnpm-lock.yaml` means pnpm. The commands below say `npm`.

## Is it running?

Mushin.js is running when `system__info` answers through the mushin MCP tools. The user starts it with `npm start` in the app folder and stops it with Ctrl+C in that terminal. You cannot start or stop it for them through MCP; ask them.

## Upgrade

1. Ask the user to stop Mushin.js.
2. Back up first (below). Upgrades move data to a new layout when they need to.
3. Run `npm run upgrade` in the app folder. It updates every `@mushinjs/*` package to the newest version of the same channel (`next` for a preview, `latest` for a release), then moves `data/` to the new version's layout. `npx mushin upgrade --tag <tag>` picks a channel.
4. Run `npm run typecheck` when the app has local plugins in `plugins/`, and fix what a changed API broke.
5. Ask the user to start it again with `npm start`, then check `plugins__list` for any plugin that is `failed`.

If something is wrong after an upgrade, the copy of the old data folder is in `data/backups/` (see Restore).

## Back up

- **Everything, with Mushin.js stopped:** copy the whole `data/` folder, plus `mushin.config.json`, `plugins/` and `skills/`. Copy `.env` separately and keep it somewhere private: it holds every key.
- **Only the database, while it runs:** `call_tool` with `database.backup` copies `mushin.db` to `data/backups/` and returns the path. Bots, providers and flows are files under `data/` too, so this is not a full backup.
- `data/backups/` grows: Mushin.js puts a copy there before it changes the folder layout, and the copy may hold old keys in plain text. Once the user has checked that everything works, offer to delete old copies; do it only after they agree.

## Restore

1. Ask the user to stop Mushin.js.
2. Move the current `data/` aside (rename it, don't delete it).
3. Copy the backup's `data/` into place, and `mushin.config.json` and `.env` if they were backed up too.
4. Start Mushin.js. A backup from an older version is moved to the current layout on start, after another copy is made.

## Move to another machine

1. On the old machine, stop Mushin.js and back up everything (above), `.env` included.
2. On the new machine, install Node.js 22.13 or newer, copy the app folder without `node_modules/`, `logs/` and `cache/`, and run `npm install`.
3. Start it with `npm start`. Bots that use OneBot 11 in reverse mode need the OneBot implementation to point at the new machine's address; `system__info` shows it.

## Migrate an old data folder

`npx mushin migrate --dry-run` lists what would move to the current layout without moving anything. `npx mushin migrate` moves it, after copying `data/` to `data/backups/`. `npm start` does the same on its own. Keys an old version kept in plain text move to `.env`.

## Admin token

The dashboard's sign-in link is printed when Mushin.js starts. If the user lost it, or the token leaked, `npx mushin token reset` makes a new one, prints the new sign-in link, and a running Mushin.js accepts it right away. Never read the token out of `.env` yourself.
