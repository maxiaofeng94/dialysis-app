import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router from './router'
import './style.css'

// 语言包等全局配置由 App.vue 里的 <el-config-provider> 提供
const app = createApp(App)
app.use(ElementPlus)
app.use(router)

let mounted = false

/**
 * 挂载并撤掉 index.html 里的启动占位。
 *
 * 与 App 端（src/main.ts）同一个道理：路由守卫要 `await` 登录态与后台权限校验，
 * 这期间 `router-view` 是空的 —— 直接 mount 会先撤掉占位、再渲染出一片空白。
 * 原来这里就是顶层直接 mount，配合「守卫 await 无上限」，弱网下等于整页白屏。
 */
function mountApp() {
  if (mounted) return
  mounted = true
  app.mount('#admin-app')
  // 路由还没就绪就别撤占位 —— 撤了就是空白（与 App.vue 的 routeReady 同义）。
  // 正常路径下 isReady() 早已 resolve，这里会立刻执行。
  router.isReady().then(
    () => requestAnimationFrame(() => document.getElementById('admin-boot')?.remove()),
    () => requestAnimationFrame(() => document.getElementById('admin-boot')?.remove()),
  )
}

router.isReady().then(mountApp, mountApp)

// 守卫被网络请求挂住时兜底挂载，让页面自己的错误提示接管
window.setTimeout(mountApp, 12000)
