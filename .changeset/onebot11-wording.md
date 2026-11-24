---
"@mushinjs/plugin-adapter-onebot": patch
"@mushinjs/plugin-bots": patch
"@mushinjs/plugin-console": patch
"@mushinjs/plugin-fairy": patch
"@mushinjs/dashboard": patch
"@mushinjs/cli": patch
"create-mushin": patch
---

The OneBot adapter, the dashboard, Fairy and the docs talk about OneBot 11 instead of NapCat alone: any implementation works, and NapCat, Lagrange and LLOneBot are named as examples. The adapter is shown as "OneBot v11", its address field is "OneBot address", connection logs and errors say "OneBot client" (reverse) or "OneBot server" (forward and http), and the non-standard APIs in the "Call OneBot API" node are marked "(extension)".
