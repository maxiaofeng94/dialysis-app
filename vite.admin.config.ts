import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

/**
 * 后台管理端独立构建配置。
 *
 * 关键点：root 指向 admin/，后台入口就是 admin/index.html，因此
 *   - 构建产物是 dist-admin/index.html —— Cloudflare Pages 项目根路径可直接访问（否则 / 会 404）
 *   - 开发时 http://127.0.0.1:5174/ 就是后台登录页（不再与 App 的 index.html 抢根路径）
 *   - 与 App 的 index.html / dist/ 完全隔离，后台代码不会随 cap sync 进 APK
 *   - 后台与 App 连同一个 Supabase 库，只用 anon key（service_role 只存在于 Edge Function）
 *
 * 开发：npm run dev:admin   → http://127.0.0.1:5174
 * 构建：npm run build:admin → dist-admin/
 */
export default defineConfig({
  root: 'admin',
  publicDir: '../public',
  plugins: [vue()],
  build: {
    outDir: '../dist-admin',
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5174,
    // Windows 下写文件会产生被锁的临时文件，watcher 撞上会直接崩（EBUSY → 进程退出）
    watch: {
      ignored: ['**/supabase/**', '**/dist/**', '**/dist-admin/**', '**/android/**', '**/*.tmpdir/**'],
    },
  },
})
