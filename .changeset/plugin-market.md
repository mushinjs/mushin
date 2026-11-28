---
"@mushinjs/core": minor
"@mushinjs/plugin-market": minor
"@mushinjs/plugin-console": minor
"@mushinjs/dashboard": minor
"@mushinjs/cli": patch
"@mushinjs/plugin-fairy": patch
---

A plugin market on the Plugins page (Plugins → Market). It reads the market index (https://mushinjs.github.io/market/index.json by default, with mirrors as a setting) or, when no index answers, npm's search for the `mushin-plugin` keyword, and shows each plugin as a card: group, official, picked, trusted publishing and built-in marks, weekly downloads, last update, and the newest version that runs on this Mushin.js (from `mushin.requires.mushin`); an incompatible one says what it needs. Installing lists the plugins that come along and, for third-party plugins, warns that the code runs with Mushin.js's rights and shows the publisher. An install that only adds packages goes in while Mushin.js runs and can turn the plugin on right away; one that would change installed packages restarts through the supervisor and rolls back when it fails. Third-party plugins can be uninstalled from their panel; built-in ones only turned off. The details panel shows a market package's README and versions, and each installed plugin's own log lines, which now carry the plugin that wrote them (`logs.recent` takes `plugin`, and the Logs page takes `?plugin=`). A setting allows only picked plugins; another switches the app's npm registry, such as to npmmirror. Updates and installs write exact versions to package.json. New actions: `market.list`, `market.package`, `market.settings`, `plugins.install`, `plugins.uninstall`; Fairy's helpers cannot install or uninstall.
