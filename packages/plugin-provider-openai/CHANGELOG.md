# @mushinjs/plugin-provider-openai

## 0.3.0

### Minor Changes

- efb9f23: OpenAI's own API is used through the Responses API, where reasoning models can use tools with a reasoning effort, and reasoning is carried through a tool loop. A new API setting picks Responses or Chat Completions for other addresses.

### Patch Changes

- 5952012: The Agent chat says when a model ran without the picked reasoning effort, the picker greys out the effort for models that do not reason, and a failed reply offers to retry or change the model.
- 8b89584: The agent chat picks a model and reasoning effort per message, and user messages can be copied, or edited and sent again. Fetched model lists show the newest models first.
- ccbd24d: A model that refuses reasoning effort together with tools in Chat Completions gets the request again without the effort, instead of failing.
- Updated dependencies [5952012]
- Updated dependencies [8b89584]
- Updated dependencies [c31a9a8]
- Updated dependencies [70a7af1]
- Updated dependencies [e4f7ee8]
- Updated dependencies [88a8c85]
  - @mushinjs/plugin-providers@0.3.0
  - @mushinjs/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [a43ed0d]
  - @mushinjs/core@0.2.0
  - @mushinjs/plugin-providers@0.2.0
