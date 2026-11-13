# @mushinjs/plugin-storage

## 0.2.0

### Minor Changes

- 7acde79: The instance folder has a new layout: `data/` holds `core/`, `bots/<id>/`, `agents/` and `plugins/<name>/` beside `mushin.db`, and bot logs move to `logs/`, which is safe to delete, as is `cache/`. Storage keys are unchanged, so plugins need no changes.
  
  `mushin start` moves an older instance to the new layout after copying its `data/` folder to `data/backups/`. `mushin migrate [--dry-run]` does the same without starting. Running it again changes nothing.
- a43ed0d: Secrets move to the instance's `.env` file. The admin token is `MUSHIN_ADMIN_TOKEN` there; provider keys, adapter secrets (such as the OneBot token) and MCP environment values and headers are written to `.env` when saved, and the records in `data/` hold `${NAME}` references. Plugin settings in `mushin.config.json` can use `${NAME}` too. A variable set in the environment overrides `.env`. Keys an older version kept in plain text move to `.env` on the next start.
  
  `resetAdminToken` and `readAdminToken` take the instance folder instead of the data folder.

### Patch Changes

- Updated dependencies [a43ed0d]
  - @mushinjs/core@0.2.0
