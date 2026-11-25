---
"@mushinjs/core": minor
"@mushinjs/plugin-terminal": minor
"@mushinjs/plugin-fairy": minor
"@mushinjs/dashboard": minor
---

Choose when Fairy asks before acting, next to its input: ask every time, default (as the settings say), approve for me (asks only before what could do lasting harm, such as deleting, pushing code or changing the system) or full access. A switch reaches the reply Fairy is working on, and approvals it waits on that the new mode would not ask for go ahead; an approval card also offers "Approve, then auto". Actions can say which inputs are risky (`risky` in `ActionDefinition`); the terminal reads commands for it, so builds, installs and scripts run without asking while `rm -rf` or `git push` still ask. Commands carry a purpose in words, shown instead of the command, which folds away. Fairy's questions use the chat's text size, "thinking" hides while Fairy waits on you, and a helper's task shows in full when opened instead of in a tooltip.
