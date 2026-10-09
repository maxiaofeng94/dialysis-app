import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'pwa-192.png', 'pwa-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: '透析记录',
        short_name: '透析记录',
        description: '透析病人体重与生命体征记录',
        lang: 'zh-CN',
        display: 'standalone',
        theme_color: '#07c160',
        background_color: '#f2f3f5',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    // Windows 下编辑文件会留下被锁的临时文件（*.tmpdir），watcher 撞上会直接崩：
    // Error: EBUSY: resource busy or locked, watch '...\.build-apk.yml.xxx.tmpdir\...'
    // 这些目录本来也不需要热更新，直接不监视（与 vite.admin.config.ts 保持一致）
    watch: {
      ignored: [
        '**/supabase/**',
        '**/.github/**',
        '**/dist/**',
        '**/dist-admin/**',
        '**/android/**',
        '**/*.tmpdir/**',
      ],
    },
  },
})
