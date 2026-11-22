# @mushinjs/dashboard

## 0.3.0

### Patch Changes

- 5952012: The Agent chat says when a model ran without the picked reasoning effort, the picker greys out the effort for models that do not reason, and a failed reply offers to retry or change the model.
- 8b89584: The agent chat picks a model and reasoning effort per message, and user messages can be copied, or edited and sent again. Fetched model lists show the newest models first.
- 88a8c85: Plugin settings can be marked secret with `field(…, { secret: true })`. The plugin manager keeps their values in `.env` with a `${NAME}` reference in the config, for app plugins and bot plugins alike: keys saved from the dashboard move there right away, keys typed into `mushin.config.json` move on the next start, lists (and so the Agent and MCP tools) show them masked, and forms show a password input.

## 0.2.0

No changes in this release.
