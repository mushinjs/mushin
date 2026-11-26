---
'@mushinjs/cli': minor
---

The terminal gets quiet once Mushin.js has started. Startup prints as before; when every plugin has started, the terminal shows only warnings and errors, with one dim line saying the full log is on the dashboard's Logs page. `--log-level error|warn|info|debug` (or `MUSHIN_LOG_LEVEL` in the shell or `.env`) sets what the terminal shows for the whole run instead.

A warning or error that repeats prints once; later copies from the same source are counted, and a line such as "the same warning repeated 20 more times (latest 10:21:33)" follows every ten minutes while it continues, and when a different warning from that source arrives.

The sign-in block is printed last, after the plugins and bots have started. Its commands run as they are from where you typed: started through `pnpm dev` or `npm start`, they go through the package manager (`pnpm exec mushin token reset --dir instance`).

`mushin open` opens the dashboard in your browser, signed in, and prints the link. It reads the admin token from the shell or the app's `.env`, so it works while Mushin.js runs in another terminal.
