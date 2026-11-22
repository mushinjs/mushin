---
"@mushinjs/core": minor
"@mushinjs/dashboard": minor
---

App plugin entries can be removed: `plugins.remove` takes an entry out of the config with its settings, disabling it first under the same rules as `plugins.disable`, and the **Plugins** page has a remove button on each entry. An entry whose package cannot be imported, such as one no longer installed, now shows as failed with the reason ("… is not installed") instead of disabled, and its row offers to remove it.
