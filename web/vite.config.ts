import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    manifest: { name: 'MaCité', short_name: 'MaCité', lang: 'fr', start_url: '/', display: 'standalone',
      background_color: '#F6F8F7', theme_color: '#0F4C75',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] },
    workbox: { globPatterns: ['**/*.{js,css,html,svg,jpg}'], maximumFileSizeToCacheInBytes: 4e6 },
  })],
  server: { proxy: { '/api': 'http://localhost:8000' } },
  test: { environment: 'node', setupFiles: ['fake-indexeddb/auto'] },
});
