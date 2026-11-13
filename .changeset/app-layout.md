---
"@mushinjs/cli": minor
"@mushinjs/plugin-storage": minor
---

The instance folder has a new layout: `data/` holds `core/`, `bots/<id>/`, `agents/` and `plugins/<name>/` beside `mushin.db`, and bot logs move to `logs/`, which is safe to delete, as is `cache/`. Storage keys are unchanged, so plugins need no changes.

`mushin start` moves an older instance to the new layout after copying its `data/` folder to `data/backups/`. `mushin migrate [--dry-run]` does the same without starting. Running it again changes nothing.
