# @mushinjs/plugin-providers

## 0.3.0

### Patch Changes

- 5952012: The Agent chat says when a model ran without the picked reasoning effort, the picker greys out the effort for models that do not reason, and a failed reply offers to retry or change the model.
- 8b89584: The agent chat picks a model and reasoning effort per message, and user messages can be copied, or edited and sent again. Fetched model lists show the newest models first.
- c31a9a8: The Agent sends at most 128 tools, the most OpenAI accepts: with more plugins and MCP servers on, the core tools are listed and the rest are found with `search_tools` and run with `call_tool`, under the same policy. A fetched model list puts the models that answer chat first, so the default model is no longer an embedding, speech or `…-chat-latest` model.
- e4f7ee8: A failed provider request is logged as an error instead of a warning.
- Updated dependencies [70a7af1]
- Updated dependencies [88a8c85]
  - @mushinjs/core@0.3.0
  - @mushinjs/plugin-storage@0.3.0

## 0.2.0

### Minor Changes

- a43ed0d: Secrets move to the instance's `.env` file. The admin token is `MUSHIN_ADMIN_TOKEN` there; provider keys, adapter secrets (such as the OneBot token) and MCP environment values and headers are written to `.env` when saved, and the records in `data/` hold `${NAME}` references. Plugin settings in `mushin.config.json` can use `${NAME}` too. A variable set in the environment overrides `.env`. Keys an older version kept in plain text move to `.env` on the next start.
  
  `resetAdminToken` and `readAdminToken` take the instance folder instead of the data folder.

### Patch Changes

- Updated dependencies [7acde79]
- Updated dependencies [a43ed0d]
  - @mushinjs/plugin-storage@0.2.0
  - @mushinjs/core@0.2.0
