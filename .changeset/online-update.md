---
"@mushinjs/core": minor
"@mushinjs/cli": minor
"@mushinjs/plugin-market": minor
"@mushinjs/dashboard": minor
"@mushinjs/plugin-fairy": patch
---

Mushin.js updates itself from the dashboard. `mushin start` now runs the app under a small supervisor (`--no-supervisor` keeps one process), so the app can restart, and an update can install while the app is stopped: the supervisor installs the new version, migrates the data, starts it and waits for it, and if the install fails or the new version does not start or crashes right away, it puts back package.json, the lock file, the packages and the data folder and starts the old version. The new Updates plugin checks npm every six hours (official packages as one Mushin.js version, third-party plugins one by one with whether they run on this version) and offers `plugins.updates`, `plugins.applyUpdates`, `system.restart`, `system.updateChannel` and `system.updateResult`. The Plugins page shows a banner with the new version and its notes, a confirm dialog, an overlay while the app is away and how it went; third-party plugins get a version chip, an Updates filter and an Updates section in their panel; Settings → About has the update channel and Restart. Fairy's helpers cannot update or restart. Each Mushin.js release gets a GitHub Release with its changes.
