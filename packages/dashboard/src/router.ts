import { createRouter, createWebHistory } from 'vue-router'
import { connection, setPage } from './api'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
    { path: '/', redirect: '/bots' },
    { path: '/setup', component: () => import('./views/SetupView.vue') },
    { path: '/providers', component: () => import('./views/ProvidersView.vue') },
    { path: '/bots', component: () => import('./views/BotsView.vue') },
    { path: '/bots/:id', redirect: (to) => `/bots/${to.params.id}/connection` },
    { path: '/bots/:id/:tab(connection|plugins|live|logs)', component: () => import('./views/BotDetailView.vue') },
    { path: '/flows', component: () => import('./views/FlowsView.vue') },
    { path: '/flows/:id', component: () => import('./views/FlowEditorView.vue') },
    { path: '/plugins', component: () => import('./views/PluginsView.vue') },
    { path: '/logs', component: () => import('./views/LogsView.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/bots' },
  ],
})

router.beforeEach((to) => {
  if (!to.meta.public && !connection.token) return { path: '/login', query: { next: to.fullPath } }
  // A sign-in link (#token=...) replaces whatever token is saved.
  if (to.path === '/login' && connection.token && !to.hash.startsWith('#token=')) return '/bots'
})

router.afterEach((to) => setPage(to.fullPath))
