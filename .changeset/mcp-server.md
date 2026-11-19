---
"@mushinjs/plugin-console": minor
"@mushinjs/core": minor
"@mushinjs/cli": minor
"create-mushin": minor
---

Mushin.js serves its actions over MCP at `/mcp`, for AI tools such as Claude Code. Requests need the admin token, and the tools follow the Agent's tool policy: tools turned off are not offered, and dangerous ones run only after the user approves them in the dashboard. A short list of tools is listed directly; `search_tools` and `call_tool` reach the rest. `mushin mcp` is a stdio bridge to it that reads the token from `.env`, and new apps (and `mushin upgrade`) get a `.mcp.json` that starts it.
