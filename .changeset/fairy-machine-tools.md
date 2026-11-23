---
"@mushinjs/core": minor
"@mushinjs/plugin-terminal": minor
"@mushinjs/plugin-fairy": minor
"@mushinjs/plugin-console": minor
"@mushinjs/dashboard": minor
---

Fairy can work on the machine running Mushin.js when the Terminal plugin is on: `terminal.run` runs a command and returns its output, `terminal.start`, `terminal.output`, `terminal.write` and `terminal.stop` handle commands that keep running such as dev servers, and `files.list`, `files.read`, `files.search`, `files.write` and `files.edit` work on files in the app folder and any extra folders set in the plugin. The plugin's **Fairy runs commands** setting asks before every command by default, and can let commands that only look run without asking, run everything, or turn commands off; **Fairy reads and writes files** can be read only or off. `.env` files are never reachable, writes stay out of `data/`, `node_modules/` and `.git/`, and writes outside `plugins/` ask first. Actions can now decide per input whether Fairy asks first (`approval` in `ctx.actions.define`). In the Fairy workspace the panel has a **Terminal** tab with every command's live output and a box to run your own, and Fairy's tool rows show the command or file they work on.
