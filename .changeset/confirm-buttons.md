---
"@mushinjs/ui": patch
---

Confirmation dialogs no longer treat the confirm button as Cancel: the dialog closed itself before the button's click ran, so callers that resolve on cancel saw every answer as a no, and `onPositiveClick` could not keep the dialog open by returning false.
