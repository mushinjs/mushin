---
"@mushinjs/cli": minor
---

Packages are published as compiled JavaScript with type declarations. `mushin start` from an npm install no longer loads tsx; it starts tsx only when the instance's `plugins/` folder holds a TypeScript plugin.

The packages are published under the `@mushinjs` scope. An instance that saved `@mushin/...` package names in `mushin.config.json` or in its bots is read with the new names and saved back.
