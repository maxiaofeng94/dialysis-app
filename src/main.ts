import { createApp } from 'vue'
import { Capacitor } from '@capacitor/core'
import Vant from 'vant'
import 'vant/lib/index.css'
import App from './App.vue'
import router from './router'
import './style.css'
// 必须放在 vant 的 CSS 之后：它用 CSS 变量接管图标字体族，指向本地字体文件
import './styles/vant-icon-font.css'

declare global {
  interface Window {
    /** index.html 的启动引导用它判断「已经起来了」，从而撤掉超时兜底 */
    __bootMounted?: () => void
  }
}

const app = createApp(App)
app.use(router)
app.use(Vant)

/**
 * Web 端：Service Worker 换新接管后立刻重载页面。
 *
 * workbox 生成的 SW 带 `skipWaiting` + `clientsClaim`：新 SW 一激活就把**当前页面**
 * 接管过去，同时按新的预缓存清单清掉旧文件。而当前页面是旧 `index.html` 渲染出来的，
 * 它后续还要的旧 hash 资源已经既不在缓存里、服务器上也没有 → 404 → 白屏。
 * （原生壳不注册 SW，见 vite.config.ts 的 DISABLE_SW。）
 *
 * 首次注册时的 `controllerchange` 只是「SW 接管了本页」，页面与 SW 同版本，重载没有意义。
 */
function reloadOnServiceWorkerUpdate() {
  if (Capacitor.isNativePlatform()) return
  if (!('serviceWorker' in navigator)) return
  let controlled = Boolean(navigator.serviceWorker.controller)
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) {
      controlled = true
      return
    }
    if (reloading) return
    reloading = true
    location.reload()
  })
}

let mounted = false

/**
 * 挂载 App 并撤掉 index.html 里的启动占位。
 *
 * 为什么不在模块顶层直接 mount：路由守卫要 `await` 登录态恢复与病人校准，
 * 这期间 `router-view` 还是空的 —— 提前 mount 会先清掉启动占位、再渲染出一片空白，
 * 用户看到的仍然是「白屏」。等首次导航就绪再挂载，占位就能一直兜到真有内容为止。
 */
function mountApp() {
  if (mounted) return
  mounted = true
  app.mount('#app')
  window.__bootMounted?.()
  // 等一帧再撤占位，避免「占位没了但首帧还没画出来」的闪白
  requestAnimationFrame(() => document.getElementById('boot-splash')?.remove())
}

router.isReady().then(mountApp, mountApp)

// 守卫要是被网络请求永久挂住（离线、弱网），也不能一直停在启动页：
// 兜底挂载，让页面自己的空态 / 错误提示接管。
window.setTimeout(mountApp, 12000)

reloadOnServiceWorkerUpdate()
