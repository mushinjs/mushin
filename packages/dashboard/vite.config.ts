import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

// In development the dashboard runs on Vite and proxies the API to a running Mushin.js instance.
const backend = process.env.MUSHIN_BACKEND ?? 'http://127.0.0.1:5160'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
})
