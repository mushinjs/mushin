// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  devtools: { enabled: true },
  modules: ['@unocss/nuxt', '@vueuse/nuxt', '@nuxtjs/color-mode', 'floating-vue/nuxt'],
  colorMode: {
    classSuffix: '',
  },
})
