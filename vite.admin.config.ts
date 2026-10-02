import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { existsSync, renameSync, rmSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

const distDir = fileURLToPath(new URL('./dist-admin', import.meta.url))

/**
 * 后台管理端独立构建配置。
 *
 * 设计（踩过两个坑后定型）：
 *   1. root 保持**项目根**，不指向 admin/。
 *      曾经把 root 设为 admin/ 让产物直接叫 index.html，结果 admin/index.html 里的入口脚本
 *      解析不到（浏览器按 URL 基准解析 → /src/admin/main.ts → root 下没有这个文件 → 页面白屏）。
 *   2. 开发时用中间件把 `/` 重写到 `/admin/index.html`，
 *      这样 5174 的根路径是后台登录页，又不会与 App 的 index.html 抢根路径。
 *   3. 构建时入口是 admin/index.html，产物会落在 dist-admin/admin/index.html，
 *      由 closeBundle 提升为 dist-admin/index.html —— Cloudflare Pages 根路径才能直接访问
 *      （否则 https://dialysis-admin.pages.dev/ 会 404）。
 *
 * 开发：npm run dev:admin   → http://127.0.0.1:5174
 * 构建：npm run build:admin → dist-admin/index.html
 */
export default defineConfig({
  root: '.',
  plugins: [
    vue(),
    {
      name: 'admin-entry',
      // 开发：根路径指向后台入口
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === '/' || req.url === '/index.html') req.url = '/admin/index.html'
          next()
        })
      },
      // 构建：把 admin/index.html 提升到产物根目录
      closeBundle() {
        const from = `${distDir}/admin/index.html`
        const to = `${distDir}/index.html`
        if (existsSync(from)) {
          renameSync(from, to)
          rmSync(`${distDir}/admin`, { recursive: true, force: true })
        }
      },
    },
  ],
  build: {
    outDir: 'dist-admin',
    emptyOutDir: true,
    rollupOptions: {
      input: { admin: fileURLToPath(new URL('./admin/index.html', import.meta.url)) },
    },
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
