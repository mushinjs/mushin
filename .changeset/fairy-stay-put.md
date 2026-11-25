---
"@mushinjs/dashboard": minor
"@mushinjs/ui": minor
"@mushinjs/plugin-fairy": minor
"@mushinjs/plugin-console": patch
---

Fairy no longer moves what you are looking at. A page Fairy wants to show you is a card in the chat with an Open button, unless you asked it to take you there; a spot it points at that is off screen gets a Show me button instead of scrolling the page; a question it asks waits in its conversation instead of popping the dock open. Settings → Features has "Let Fairy open pages by itself" for the old behavior. The chat follows new messages only while you are at its end; scrolled up, it stays put and a button says there is more below. In the workspace, tabs Fairy opens in the side panel (pages, the terminal, the browser) join it in the background with a dot, the panel stays as you left it, and a terminal or browser tab you closed stays closed until you open it again.

You can see what Fairy is doing from any page: the Fairy button counts the conversations that are running or waiting for you, and resting the pointer on it lists them. A conversation you are not looking at tells you with a toast when it finishes, fails, or needs your approval or answer, and the toast opens it. The workspace's session list and the history mark conversations that wait for you.

The session list from `fairy.sessions` has `waiting: 'confirm' | 'ask'` on a running conversation that waits for an approval or an answer, its helpers' included. `ui.navigate` and `ui.highlight` take `asked: true` when the user asked to be taken there.

`@mushinjs/ui` adds `HoverCard`, a panel that opens while the pointer rests on its trigger, and toasts take an `action` button.
