# @mushin/ui

The Vue components and design tokens of the Mushin.js dashboard. The dashboard is built on them, and a plugin page can use them to look and behave like the rest of the dashboard in both the light and the dark theme.

Most plugins do not need a page. A plugin that declares a config schema gets its settings form from the dashboard's SchemaForm, which is built on these components. Write a page only for what a form cannot show.

## Setup

```ts
// main.ts
import '@mushin/ui/theme.css'
import 'virtual:uno.css'
```

```vue
<!-- App.vue: once, around everything -->
<UiProvider :text="{ close: '关闭', cancel: '取消' }">
  <RouterView />
</UiProvider>
```

`UiProvider` draws toasts and confirmation dialogs and gives the components their words (`text`, see `UiText` in `config.ts`; English is the default). Set `data-theme="dark"` or `data-theme="light"` on `<html>` to switch the palette.

Build with UnoCSS. Use the repository's `uno.config.ts`, or make your own from the same presets:

```ts
import { defineConfig, presetIcons, presetWind3 } from 'unocss'
import { presetMushin } from '@mushin/ui/preset'

export default defineConfig({
  presets: [
    presetWind3({ dark: { dark: 'html[data-theme="dark"]', light: 'html[data-theme="light"]' } }),
    presetIcons(),
    presetMushin(),
  ],
})
```

## Components

Alert, Avatar, Button, Card, Checkbox, DataTable, Drawer, Dropdown, Empty, Form, FormItem, Image, Input, KeyValueInput, Modal, NumberInput, Pagination, Popover, Progress, RadioButton, RadioGroup, Select, Slider, Spin, TabPane, Tabs, Tag, TagsInput, TimeInput, Toggle, Tooltip.

The props follow the Naive UI ones the dashboard used before: `value` with `update:value` (so `v-model:value`), `type` (`default`, `primary`, `info`, `success`, `warning`, `error`), `size` (`tiny`, `small`, `medium`, `large`), and `secondary`, `quaternary`, `circle` on buttons. Overlays use Reka UI, which handles focus and the keyboard.

Every component passes its attributes through, so `class`, `title`, `aria-*` and `data-agent-target` reach the element. The agent highlights controls by `data-agent-target`; keep it on the controls it points at.

Run the dashboard in development and open `/dev/ui` to see every component in its states.

## Toasts and confirmations

```ts
import { useConfirm, useToast } from '@mushin/ui'

const toast = useToast()
const confirm = useConfirm()

toast.success('Saved')
confirm.warning({
  title: 'Delete this flow?',
  content: 'Its runs are kept.',
  positiveText: 'Delete',
  negativeText: 'Cancel',
  onPositiveClick: () => remove(),
})
```

`onPositiveClick` may return a promise. The button shows a spinner until the promise settles, and the dialog stays open if it returns `false`.

## Icons

Icons are class names from Iconify: `<span class="i-lucide-trash-2" />`, or `icon="i-lucide-trash-2"` on a Button or Tag. Use lucide first. When lucide has no match, use phosphor (`i-ph-…`) or carbon (`i-carbon-…`). Use svg-logos (`i-logos-…`) for brands.

Write each class name out in full. UnoCSS finds class names by reading the source, so it never finds one put together at runtime, like `` `i-lucide-${name}` ``. For an icon that depends on data, use a table of full names (`{ keyword: 'i-lucide-terminal' }`).

## Colours and CSS

- Take colours only from the tokens in `theme.css`, as CSS variables (`var(--s1)`, `var(--fg2)`, `var(--primary)`) or utilities (`bg-s1`, `text-fg2`, `border-line`, `bg-primary-soft`, `text-bad`). Both themes then work without extra rules.
- Use Tailwind-style utilities only (presetWind3). Do not use attributify mode or variant groups.
- The dashboard also runs in Tauri's WebKitGTK on Linux. Do not use native CSS nesting or `@container` queries.

## Plugin pages

- Declare `vue` and `@mushin/ui` as peer dependencies, so the page uses the dashboard's copies and not a second Vue.
- Keep the page's own CSS from leaking into the dashboard. Use scoped styles or a class prefix for the plugin, or put the rules in an `@layer`.
- Do not restyle the shared components from outside (`.mu-button { … }`). If one is missing something, add it to `@mushin/ui`.
- Write the page's words in both English and Simplified Chinese, as the dashboard does.
