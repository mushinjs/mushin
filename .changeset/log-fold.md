---
'@mushinjs/core': minor
'@mushinjs/plugin-bots': patch
'@mushinjs/plugin-console': minor
'@mushinjs/dashboard': minor
---

Log views fold repeated lines. One line repeating, or a block of up to five lines repeating back to back (a bot that cannot reach its OneBot server logs "connecting", "cannot reach" and "reconnecting in 30s" over and over), shows once with a ×N badge; lines count as the same when level, source and text match with the numbers left out. Folding happens after the filters, so Warnings turns such a cycle into one line. The badge's tooltip has the first and latest time and the texts that differed; clicking it opens the group in place. "Fold repeats" in the toolbar turns it off, and the browser remembers. Copying a folded row copies one line with the count and the first and latest time. The stored log and `bots.logs` / `logs.recent` stay as they were; the folding rules are in `@mushinjs/core/log-fold`.

The Logs page has "Show debug logs". Debug lines of Mushin.js itself go only to the tabs that turned it on, and `logs.recent` takes `level` (`debug` adds them).

A bot's log read from the daily files comes back in time order; lines written in the same millisecond could be out of order before.
