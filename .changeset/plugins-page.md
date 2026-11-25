---
"@mushinjs/core": minor
"@mushinjs/dashboard": minor
"@mushinjs/ui": minor
"@mushinjs/cli": patch
---

The **Plugins** page is grouped by what plugins do (bot plugins, platform adapters, model providers, AI and agents, features, foundation, examples), from the new `mushin.category` field. Groups fold and remember it; a group with a problem stays open. Each row shows only its icon, name, description, gear and switch, and hovering explains the rest: the package and what it needs, what turning it on or off takes along, and its current settings. Clicking a plugin opens a details panel beside the list with its status, where it is used, its settings (as a form or as JSON, with changed fields marked), its dependencies and what it adds; ↑/↓ move through plugins and `?open=<package>&tab=<section>` links to it. The HTTP server gets a settings form. `Drawer` takes `modal: false` for a panel without a mask.
