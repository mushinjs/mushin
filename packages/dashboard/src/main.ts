import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { connect, handleClientAction, on } from './api'
import App from './App.vue'
import { highlight } from './highlight'
import { i18n } from './i18n'
import { router } from './router'
import './style.css'

// Client actions the Agent can run in this tab.
handleClientAction('ui.navigate', async ({ path }: { path: string }) => {
  await router.push(path)
  return { ok: true, path: router.currentRoute.value.fullPath }
})
handleClientAction('ui.highlight', ({ target, message }: { target: string; message?: string }) => highlight(target, message))

// A saved token the server no longer accepts (e.g. after `mushin token reset`) leads back to sign-in.
on('logout', (reason: string) => {
  if (reason !== 'expired' || router.currentRoute.value.path === '/login') return
  router.push({ path: '/login', query: { expired: '1', next: router.currentRoute.value.fullPath } })
})

const app = createApp(App).use(createPinia()).use(router).use(i18n)
// Before the first route resolves, App cannot tell public pages from signed-in ones.
router.isReady().then(() => app.mount('#app'))
connect()
