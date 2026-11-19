---
"@mushinjs/plugin-agent": patch
"@mushinjs/plugin-providers": patch
---

The Agent sends at most 128 tools, the most OpenAI accepts: with more plugins and MCP servers on, the core tools are listed and the rest are found with `search_tools` and run with `call_tool`, under the same policy. A fetched model list puts the models that answer chat first, so the default model is no longer an embedding, speech or `…-chat-latest` model.
