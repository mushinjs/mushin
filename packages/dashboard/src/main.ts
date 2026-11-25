import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { connect, handleClientAction, on } from './api'
import App from './App.vue'
import { highlight } from './highlight'
import { i18n } from './i18n'
import { router } from './router'
import { prefs } from './prefs'
import { conversationOf } from './stores/fairy'
import { workspace } from './stores/workspace'
import '@mushinjs/ui/theme.css'
import 'virtual:uno.css'
import './style.css'

// Client actions Fairy can run in this tab. None of them moves what you are looking at unless you asked:
// in the Fairy workspace a page joins the side panel as a tab; elsewhere it is offered as a card in the chat.
handleClientAction('ui.navigate', async ({ path, asked }: { path: string; asked?: boolean }) => {
  if (workspace.active) {
    const view = workspace.openView({ kind: 'page', path }, { from: 'fairy' })
    return { ok: true, panel: view?.path ?? path, note: 'The page is a tab in the side panel; the user switches to it.' }
  }
  if (router.currentRoute.value.path === path.split(/[?#]/)[0] && !path.includes('?')) return { ok: true, path, note: 'The user is on this page already.' }
  if (!asked && !prefs.fairyOpensPages) return { ok: true, offered: path, note: 'The user sees a card for the page in the chat and opens it when they want; do not offer it again.' }
  await router.push(path)
  return { ok: true, path: router.currentRoute.value.fullPath }
})
handleClientAction('ui.panel', (input: { kind: 'page' | 'web' | 'status' | 'terminal' | 'browser'; path?: string; url?: string; title?: string }) => {
  if (!workspace.active) throw new Error('The user is not in the Fairy workspace; use ui.navigate to open a page')
  const view = workspace.openView(input, { from: 'fairy' })
  if (!view) return { ok: true, skipped: true, note: `The user closed the ${input.kind} tab, so it was not opened again; tell them if they need to see it.` }
  return { ok: true, shown: view.kind === 'web' ? view.url : view.path ?? view.kind, note: 'The tab is in the side panel; the user switches to it.' }
})
handleClientAction('ui.ask', (input: { question: string; options: { label: string; description?: string }[]; recommended?: number; allowOther?: boolean }, meta) => conversationOf(meta.session).ask({ ...input, ...(meta.session ? { session: meta.session } : {}) }))
handleClientAction('ui.highlight', ({ target, message, asked }: { target: string; message?: string; asked?: boolean }) => highlight(target, message, { scroll: asked || prefs.fairyOpensPages }))

// A saved token the server no longer accepts (e.g. after `mushin token reset`) leads back to sign-in.
on('logout', (reason: string) => {
  if (reason !== 'expired' || router.currentRoute.value.path === '/login') return
  router.push({ path: '/login', query: { expired: '1', next: router.currentRoute.value.fullPath } })
})

// Every shared component in its states, for checking a change in both themes.
if (import.meta.env.DEV) router.addRoute({ path: '/dev/ui', component: () => import('./views/UiPreviewView.vue'), meta: { public: true } })

const app = createApp(App).use(createPinia()).use(router).use(i18n)
// Before the first route resolves, App cannot tell public pages from signed-in ones.
router.isReady().then(() => app.mount('#app'))
connect()
