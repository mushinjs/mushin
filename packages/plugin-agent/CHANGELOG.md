# @mushinjs/plugin-agent

## 0.3.0

### Patch Changes

- 5952012: The Agent chat says when a model ran without the picked reasoning effort, the picker greys out the effort for models that do not reason, and a failed reply offers to retry or change the model.
- 8b89584: The agent chat picks a model and reasoning effort per message, and user messages can be copied, or edited and sent again. Fetched model lists show the newest models first.
- 4015d84: The Agent says when a job needs a code plugin, and points to a coding agent with the mushin MCP server, instead of asking the user for plugin docs.
- afbb235: Tool schemas sent to the model leave out regex patterns with Unicode property escapes, which OpenAI refuses.
- c31a9a8: The Agent sends at most 128 tools, the most OpenAI accepts: with more plugins and MCP servers on, the core tools are listed and the rest are found with `search_tools` and run with `call_tool`, under the same policy. A fetched model list puts the models that answer chat first, so the default model is no longer an embedding, speech or `…-chat-latest` model.
- Updated dependencies [5952012]
- Updated dependencies [8b89584]
- Updated dependencies [c31a9a8]
- Updated dependencies [70a7af1]
- Updated dependencies [e4f7ee8]
- Updated dependencies [88a8c85]
  - @mushinjs/plugin-providers@0.3.0
  - @mushinjs/core@0.3.0
  - @mushinjs/plugin-storage@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [7acde79]
- Updated dependencies [a43ed0d]
  - @mushinjs/plugin-storage@0.2.0
  - @mushinjs/core@0.2.0
  - @mushinjs/plugin-providers@0.2.0
