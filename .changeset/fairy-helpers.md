---
"@mushinjs/plugin-fairy": minor
"@mushinjs/dashboard": minor
---

Fairy hands bigger jobs to helpers with `fairy__delegate`: **debug** finds out why something fails and changes nothing, **setup** installs and connects plugins, bots, providers and MCP servers, and **builder** builds flows. Each helper works in a conversation of its own, with its own prompt and only the tools its role allows (under the same tool policy), and ends with a report (status, summary, findings, changes, next step) that Fairy reads to decide what to do next. In the dashboard a task shows as a card under Fairy's reply with the helper's progress, its approvals and its report, and opens the helper's conversation. Plugins add roles with `ctx.fairy.defineRole()`; `fairy.roles.list` lists them.
