---
"@mushinjs/plugin-browser": minor
"@mushinjs/cli": minor
"@mushinjs/plugin-fairy": minor
"@mushinjs/plugin-console": minor
"@mushinjs/dashboard": minor
---

New plugin `@mushinjs/plugin-browser` lets Fairy use Chrome, Edge or Chromium on this machine. `browser.open` returns the page as an outline in which each element has a ref. `browser.click`, `browser.type`, `browser.select` and `browser.press` act on those refs, and `browser.scroll`, `browser.back`, `browser.wait`, `browser.tabs`, `browser.tab`, `browser.screenshot`, `browser.evaluate` and `browser.close` cover the rest. The browser keeps its own profile so sign-ins stay. It runs without a window on servers. A setting makes clicks and typing ask first. The Fairy workspace has a **Browser** tab that shows the page after every step. There you can type an address, switch tabs, or click the picture to click the page. Fairy's tool rows show the address or the text typed.
