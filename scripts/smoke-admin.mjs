/**
 * 后台管理端「页面冒烟测试」——不需要浏览器。
 *
 * 用 Vite 的 ssrLoadModule 加载每个页面组件，再 renderToString 渲染一遍，
 * 用来暴露构建期检查不到的问题：模板运行时错误、setup 同步异常、
 * 组件名写错（会被静默渲染成空元素）等。
 *
 * onMounted 里的接口调用在 SSR 下不会执行，因此不会真的发请求、也不会写数据。
 *
 * 注意：Element Plus 在 SSR 下要求额外注入两个 key（ID_INJECTION_KEY / ZINDEX_INJECTION_KEY），
 * 否则会刷警告。这两个警告只存在于本测试环境，真实浏览器里不会出现。
 *
 * 用法：npm run smoke:admin
 */
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createRouter, createMemoryHistory } from 'vue-router'
import ElementPlus, { ID_INJECTION_KEY, ZINDEX_INJECTION_KEY, ElConfigProvider } from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'

// ============================================================
// 1. 契约检查：前端 api.ts 调用的 action 必须与后端 HANDLERS 完全对应
//    （action 名是字符串，vue-tsc 检查不到；拼错只会在运行时报「未知操作」）
// ============================================================
const frontSource = readFileSync('src/admin/lib/api.ts', 'utf8')
const backSource = readFileSync('supabase/functions/admin-api/index.ts', 'utf8')

const frontActions = new Set()
// 泛型可能是嵌套的（如 call<Paged<AdminUserRow>>('user.list')），所以不能用 [^>]*
for (const m of frontSource.matchAll(/call<[\s\S]{0,300}?>\(\s*'([^']+)'/g)) frontActions.add(m[1])
for (const m of frontSource.matchAll(/[^a-zA-Z]call\(\s*'([^']+)'/g)) frontActions.add(m[1])

const handlersBlock = backSource.match(/const HANDLERS: Record<string, Handler> = \{([\s\S]*?)\n\}/)
if (!handlersBlock) {
  console.log('❌ 无法从 admin-api/index.ts 解析出 HANDLERS 表')
  process.exit(1)
}
const backActions = new Set([...handlersBlock[1].matchAll(/'([^']+)':/g)].map((m) => m[1]))
backActions.add('whoami') // 特殊分支：非管理员也要能调，不走 HANDLERS

const missingInBackend = [...frontActions].filter((a) => !backActions.has(a))
const notUsedByFrontend = [...backActions].filter((a) => !frontActions.has(a))

console.log(`契约检查：前端调用 ${frontActions.size} 个 action，后端注册 ${backActions.size} 个`)
if (missingInBackend.length) {
  console.log(`❌ 前端调用了后端不存在的 action：${missingInBackend.join(', ')}`)
  process.exit(1)
}
if (notUsedByFrontend.length) {
  console.log(`⚠️ 后端注册但前端未使用：${notUsedByFrontend.join(', ')}`)
}
console.log('✅ action 契约一致\n')

// ============================================================
// 2. 页面冒烟：SSR 渲染每个页面
// ============================================================

// 与 src/admin/router.ts 的路由表保持一致（含各页面依赖的路由参数）
const views = [
  ['LoginView', '/login'],
  ['DashboardView', '/'],
  ['UserListView', '/users'],
  ['UserDetailView', '/users/demo-id'],
  ['PatientListView', '/patients'],
  ['PatientDetailView', '/patients/demo-id'],
  ['AuditView', '/audit'],
  ['MeView', '/me'],
]

const vite = await createServer({
  configFile: false,
  plugins: [vue()],
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})

let failed = 0
let warned = 0
for (const [name, path] of views) {
  try {
    const mod = await vite.ssrLoadModule(`/src/admin/views/${name}.vue`)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
    })
    await router.push(path)
    await router.isReady()

    // 与 main.ts / App.vue 的真实结构一致：页面渲染在 <el-config-provider> 之内
    const app = createSSRApp({
      render: () => h(ElConfigProvider, { locale: zhCn }, { default: () => h(mod.default) }),
    })
    app.use(router)
    app.use(ElementPlus)
    // SSR 专用的两个注入器（浏览器端不需要）
    app.provide(ID_INJECTION_KEY, { prefix: 1000, current: 0 })
    app.provide(ZINDEX_INJECTION_KEY, { current: 0 })
    app.config.warnHandler = (msg) => {
      warned++
      console.log(`   ⚠️ ${name} 警告：${msg}`)
    }

    const html = await renderToString(app)
    const ok = typeof html === 'string' && html.length > 0
    console.log(`${ok ? '✅' : '❌'} ${name.padEnd(18)} 渲染出 ${html.length} 字节 HTML`)
    if (!ok) failed++
  } catch (err) {
    failed++
    console.log(`❌ ${name.padEnd(18)} 渲染失败：${err.message}`)
  }
}

await vite.close()
console.log(
  failed
    ? `\n❌ ${failed}/${views.length} 个页面渲染失败`
    : `\n✅ ${views.length} 个页面全部渲染成功（渲染期警告 ${warned} 条）`,
)
process.exit(failed ? 1 : 0)
