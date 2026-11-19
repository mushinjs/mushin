---
"@mushinjs/cli": minor
"@mushinjs/plugin-console": patch
"create-mushin": minor
---

Four official skills for AI tools ship with the CLI: writing a plugin (starting with the questions to ask the user), building and testing flows, troubleshooting from logs and run records, and running the app (upgrades, backups, moving machines). New apps get them in `.claude/skills/`, `mushin upgrade` replaces them with the new version's, `mushin start` adds any that are missing, and `mushin skills` installs them on demand.
