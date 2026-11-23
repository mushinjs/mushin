---
"@mushinjs/core": minor
"@mushinjs/cli": minor
"@mushinjs/plugin-terminal": minor
"@mushinjs/plugin-fairy": minor
"@mushinjs/dashboard": minor
---

Fairy can write plugins itself. With the Terminal plugin on, a job that needs code (an outside API, data processing, a scheduled job) goes to the new **Developer** helper. Fairy first asks what the plugin should do. The helper then creates the plugin with the new `plugins.new` action, writes and reloads the code, tries it on a bot's sandbox chat, and reports its settings. Helpers now keep to their role's tools whatever name they send, and a role can run actions that appear after it started through `call_tool` (`tools.call`) and can need actions before Fairy offers it (`needs`).

Local plugins can live in folders outside the app. Add them on the Plugins page (**Plugin folders**), with `plugins.folders.set`, or as `pluginDirs` in `mushin.config.json`. A development copy and an instance can share one folder. A plugin there imports `@mushinjs/*` from the app. Reloading a local plugin now runs its files as they are, including the files it imports, without a restart. `pnpm dev` no longer restarts when a file in a plugin folder changes.
