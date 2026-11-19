---
'@mushinjs/plugin-agent': patch
---

Tool schemas sent to the model leave out regex patterns with Unicode property escapes, which OpenAI refuses.
