---
"@mushin/cli": minor
---

Packages are published as compiled JavaScript with type declarations. `mushin start` from an npm install no longer loads tsx; it starts tsx only when the instance's `plugins/` folder holds a TypeScript plugin.
