---
"@mushinjs/plugin-bots": minor
"@mushinjs/plugin-adapter-qq": patch
"@mushinjs/plugin-adapter-telegram": patch
"@mushinjs/plugin-adapter-discord": patch
"@mushinjs/plugin-adapter-kook": patch
"@mushinjs/plugin-adapter-onebot": patch
"@mushinjs/dashboard": minor
---

Adding a bot is now a step-by-step dialog: pick a platform from its logo, connect (a QR scan connects right away, or "Connect later"), name it (the account's own name by default), pick plugins and masters, and land on a summary. Adapters can give a `description`, an `icon` (SVG paths or an image used as a mask) and a `color`, shown in the picker and faintly behind each bot card, and an `order`; the demo sandbox, which needs no account, is listed first. OneBot 11 shows the OneBot logo. `bots.create` with `enabled: false` saves a bot whose connection is not filled in yet, and renaming a bot no longer restarts it. The Stop buttons are red. Telegram bots show their profile photo and Discord bots without one get Discord's default picture. The bots list drops connection addresses and shows the enabled plugins on hover; the bot overview is a set of tiles that open each page, and going back from one returns to the overview.
