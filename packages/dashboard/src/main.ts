import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { connect, handleClientAction, on } from './api'
import App from './App.vue'
import { highlight } from './highlight'
import { i18n } from './i18n'
import { router } from './router'
import { conversationOf } from './stores/fairy'
import { workspace } from './stores/workspace'
import '@mushinjs/ui/theme.css'
import 'virtual:uno.css'
import './style.css'

// Client actions Fairy can run in this tab.
// In the Fairy workspace a page opens in the side panel, so the chat stays where it is.
handleClientAction('ui.navigate', async ({ path }: { path: string }) => {
  if (workspace.active) return { ok: true, panel: workspace.openView({ kind: 'page', path }).path }
  await router.push(path)
  return { ok: true, path: router.currentRoute.value.fullPath }
})
handleClientAction('ui.panel', (input: { kind: 'page' | 'web' | 'status' | 'terminal'; path?: string; url?: string; title?: string }) => {
  if (!workspace.active) throw new Error('The user is not in the Fairy workspace; use ui.navigate to open a page')
  const view = workspace.openView(input)
  return { ok: true, shown: view.kind === 'web' ? view.url : view.path ?? view.kind }
})
handleClientAction('ui.ask', (input: { question: string; options: { label: string; description?: string }[]; recommended?: number; allowOther?: boolean }, meta) => conversationOf(meta.session).ask(input))
handleClientAction('ui.highlight', ({ target, message }: { target: string; message?: string }) => highlight(target, message))

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
