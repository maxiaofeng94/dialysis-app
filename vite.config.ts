import { defineConfig, loadEnv, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * 把云端域名的 preconnect / dns-prefetch 写进 index.html。
 *
 * 为什么值得单独做：手机上的首次请求要现做 DNS + TLS 握手（生产库实测首次 1489ms、
 * 后续约 310ms），移动数据下这一步还更容易失败 —— 表现就是「用流量登录总报网络异常」。
 * preconnect 让浏览器在**页面刚打开**（用户还在输手机号）时就把连接建好，
 * 之后点登录直接复用，省掉那次握手。
 *
 * 域名来自 .env / .env.production，未配置云端（纯本地单机版）时不注入。
 */
function supabasePreconnect(url: string | undefined): Plugin {
  let origin = ''
  try {
    origin = url ? new URL(url).origin : ''
  } catch {
    origin = ''
  }
  return {
    name: 'dialysis:supabase-preconnect',
    transformIndexHtml(html) {
      if (!origin) return html
      return html.replace(
        '</head>',
        `    <link rel="preconnect" href="${origin}" crossorigin />\n` +
          `    <link rel="dns-prefetch" href="${origin}" />\n` +
          `  </head>`,
      )
    },
  }
}

/**
 * APK（Capacitor 原生壳）产物禁用 Service Worker。
 *
 * 原生壳的资源全部来自 APK 本地文件，预缓存不带来任何收益，却会制造白屏：
 * 覆盖安装后 WebView 里还是上一次的 SW 与预缓存，它用 NavigationRoute 返回**旧的
 * index.html**；而旧 HTML 引用的旧 hash 资源会被新 SW 的 skipWaiting + 预缓存清理删掉
 * → 脚本 404 → 整页白屏。build-apk.yml 用 `DISABLE_SW=1` 构建 web 产物；
 * Web 端（Cloudflare Pages）靠 SW 离线可用，保持启用。
 */
const disableServiceWorker = process.env.DISABLE_SW === '1'

export default defineConfig(({ mode }) => {
  // 读 .env / .env.production 里的 VITE_* 变量（preconnect 的目标域名从这里来）
  const env = loadEnv(mode, process.cwd(), '')

  return {
    /**
     * 语法降级到 ES2017（Chrome 55+）。
     *
     * 为什么必须显式指定：Vite 8 的默认 target 是 `baseline-widely-available`，
     * 实测打出来的入口 chunk 含 `?.` / `??` / `??=` / class 私有字段，**需要 ES2022
     * 也就是 Chrome 94+**；而 Capacitor 认为「WebView 版本够用」的门槛只有 60
     * （`Bridge.DEFAULT_ANDROID_WEBVIEW_VERSION`），`minSdkVersion` 又允许装到 Android 5.1。
     * 中间这一整段设备（老机、部分国产 ROM 自带 WebView）打开就是入口脚本 SyntaxError
     * → 白屏，而且 Capacitor 不会拦、只会静默加载。
     *
     * es2017 能覆盖 async/await（esbuild 无法把它降到更低），同时把可选链、空值合并、
     * 私有字段这些全部降级掉 —— 兼容门槛从 Chrome 94 提前到 Chrome 55。
     */
    build: {
      target: 'es2017',
    },
    plugins: [
      vue(),
      supabasePreconnect(env.VITE_SUPABASE_URL),
      ...(disableServiceWorker
        ? []
        : [
            VitePWA({
              registerType: 'autoUpdate',
              includeAssets: [
                'icon.svg',
                'pwa-192.png',
                'pwa-512.png',
                'apple-touch-icon.png',
                // 图标字体必须一起预缓存：workbox 默认的 globPatterns 只覆盖 js/css/html，
                // woff2 不在内 —— 而「透析室信号差时图标不能空白」正是当初把字体本地化的原因
                // （图标承担了返回 / 删除 / 分享 / 记录等主要操作入口）。
                // 少了这两行，本地化只解决了一半问题：CDN 不再被 CSP 拦，但离线仍然没有图标。
                'fonts/vant-icon.woff2',
                'fonts/vant-icon.woff',
              ],
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
          ]),
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
  }
})
