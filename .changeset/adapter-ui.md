---
"@mushinjs/plugin-bots": minor
"@mushinjs/plugin-adapter-onebot": patch
"@mushinjs/dashboard": minor
---

Adapters can list the config fields each connection mode leaves out (`hiddenFields`), and the dashboard's bot forms follow it for every adapter instead of only OneBot. The forms show each adapter's setup guide and, for reverse, HTTP and webhook modes, the address the platform reaches Mushin at. `mediaSource()` and `mediaBytes()` in `@mushinjs/plugin-bots` read an outgoing image, voice, video or file segment from an address, a `base64://` or `data:` payload or a local path, for adapters that upload media.
