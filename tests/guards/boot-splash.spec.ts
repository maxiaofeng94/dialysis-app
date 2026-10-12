/**
 * 静态守卫 · 启动兜底（白屏防线）
 *
 * 用户反馈「安装 APK 后高频率打开就是一片空白」。复盘下来有三条独立成因，
 * 每一条都不会被编译器或构建发现，只能在这里钉住：
 *
 * 1. **原生壳里残留的 Service Worker**：覆盖安装后 WebView 仍是上一次的 SW，
 *    它用 NavigationRoute 返回**旧的 index.html**，而旧 HTML 引用的旧 hash 资源
 *    已经被新 SW 的 skipWaiting + 预缓存清理删掉 → 脚本 404 → 白屏。
 *    → 原生壳不注册 SW（构建时 DISABLE_SW）、启动时清掉残留（public/boot.js +
 *      MainActivity 删 Service Worker 目录），Web 端则要在 SW 换新后立刻重载。
 * 2. **JS 起来之前是纯白**：2MB 的首屏包在低端机上要解析好几秒，
 *    而 `#app` 一直是空的 → 用户以为「打不开」，只能杀进程。
 *    → index.html 里放内联样式的启动占位，失败时给「重新打开」按钮。
 * 3. **路由守卫被网络挂死**：守卫 await 登录态恢复与病人校准，
 *    这期间 `router-view` 渲染为空 → 提前挂载等于白屏。
 *    → 等 `router.isReady()` 再挂载 + 超时兜底 + 每一步网络请求都有上限。
 *
 * ⚠️ 引导脚本必须是**外链**（public/boot.js）。生产 CSP 的 script-src 不含
 * `'unsafe-inline'`，内联脚本会被浏览器直接拦掉、兜底逻辑等于没写 —— 这个坑真踩过。
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 这个文件跑在 jsdom 环境（要用 DOMParser 解析 index.html），
// 此时 import.meta.url 不是 file: 协议，只能按工作目录定位项目根
const ROOT = process.cwd()

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
}

function parseHtml(rel: string) {
  const html = read(rel)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const scripts = [...doc.querySelectorAll('script')]
  return {
    html,
    doc,
    inlineScripts: scripts.filter((s) => !s.getAttribute('src')).map((s) => s.textContent ?? ''),
    scriptSrcs: scripts.map((s) => s.getAttribute('src') ?? ''),
    inlineStyles: [...doc.querySelectorAll('style')]
      .map((s) => s.textContent ?? '')
      .join('\n'),
  }
}

const index = parseHtml('index.html')
const boot = read('public/boot.js')

describe('启动兜底 · CSP 一致性（绝不能有内联脚本）', () => {
  const headers = read('public/_headers')
  // 只从真正的 CSP 响应头那一行取，别被文件顶部注释里提到的 script-src 带偏
  const cspLine = headers.split(/\r?\n/).find((l) => /^\s*Content-Security-Policy:/.test(l)) ?? ''
  const scriptSrc = (cspLine.match(/script-src([^;]*)/) ?? [])[1] ?? ''

  it('_headers 里确实声明了 CSP（否则下面几条断言是空转）', () => {
    expect(cspLine, 'public/_headers 里找不到 Content-Security-Policy 行').not.toBe('')
    expect(scriptSrc, 'CSP 里找不到 script-src 指令').not.toBe('')
  })

  it('前置条件：生产 CSP 的 script-src 不含 unsafe-inline', () => {
    expect(
      scriptSrc,
      '如果这里开始允许 unsafe-inline，下面几条断言就失去意义了，请一并复核 public/_headers',
    ).not.toMatch(/unsafe-inline/)
  })

  it('index.html 里没有内联 <script>（内联会被 CSP 静默拦掉，兜底等于没写）', () => {
    expect(
      index.inlineScripts,
      '启动引导脚本必须放 public/boot.js 并用 <script src="/boot.js"> 引用：\n' +
        "生产 CSP 是 script-src 'self' ...，内联脚本会被拦掉（控制台报 " +
        'Executing inline script violates ...），白屏兜底直接失效',
    ).toEqual([])
  })

  it('后台管理端 index.html 同样没有内联 <script>（与 App 共用同一份 _headers）', () => {
    expect(parseHtml('admin/index.html').inlineScripts).toEqual([])
  })

  it('index.html 引用了 /boot.js', () => {
    expect(index.scriptSrcs).toContain('/boot.js')
  })

  it('引导脚本在入口脚本之前加载（没有 async/defer，保持同步阻塞）', () => {
    const bootAt = index.html.indexOf('/boot.js')
    const entryAt = index.html.indexOf('/src/main.ts')

    expect(bootAt).toBeGreaterThanOrEqual(0)
    expect(bootAt, 'boot.js 必须排在入口脚本前面').toBeLessThan(entryAt)
    expect(
      /<script src="\/boot\.js"><\/script>/.test(index.html),
      'boot.js 不能加 async/defer：那样它就不再保证「在页面渲染前执行」',
    ).toBe(true)
  })

  it('boot.js 真的存在（public/ 会被原样复制到产物根目录）', () => {
    expect(existsSync(resolve(ROOT, 'public/boot.js'))).toBe(true)
  })
})

describe('启动兜底 · index.html 的启动占位', () => {
  it('启动占位存在，且**不在 #app 里面** —— Vue 挂载时不会顺手把它清掉', () => {
    const app = index.doc.getElementById('app')
    const splash = index.doc.getElementById('boot-splash')

    expect(app, 'index.html 里找不到 #app').not.toBeNull()
    expect(splash, 'index.html 里找不到 #boot-splash：JS 起来之前又是纯白').not.toBeNull()
    // 放进 #app 里会被 app.mount() 清空 —— 那样「等路由就绪再挂载」就没有意义了
    expect(app!.contains(splash!), '#boot-splash 不能是 #app 的子元素').toBe(false)
  })

  it('占位样式是内联的（外链 CSS 到达之前页面已经在渲染）', () => {
    expect(index.inlineStyles, '启动占位的样式必须内联，否则首帧仍是白屏').toMatch(/#boot-splash/)
    expect(index.inlineStyles).toMatch(/position:\s*fixed/)
  })

  it('占位在 <body> 里排在 module 脚本之前（先有内容，再谈执行）', () => {
    const body = index.html.slice(index.html.indexOf('<body>'), index.html.indexOf('</body>'))
    const splashAt = body.indexOf('id="boot-splash"')
    const scriptAt = body.indexOf('type="module"')

    expect(splashAt).toBeGreaterThanOrEqual(0)
    expect(scriptAt).toBeGreaterThanOrEqual(0)
    expect(splashAt, '启动占位必须在入口脚本之前').toBeLessThan(scriptAt)
  })
})

describe('启动兜底 · public/boot.js 的职责', () => {
  it('用 ES5 语法（老 WebView 解析不了就直接白屏）', () => {
    expect(boot.length, 'boot.js 是空的').toBeGreaterThan(0)
    expect(boot, 'boot.js 不要用箭头函数').not.toMatch(/=>/)
    expect(boot, 'boot.js 不要用模板字符串').not.toMatch(/`/)
    expect(boot, 'boot.js 不要用 let / const').not.toMatch(/\b(let|const)\s/)
  })

  it('只在原生壳里清 Service Worker —— Web 端要靠它离线可用', () => {
    expect(boot, '缺少原生壳判断：Web 端会被误清掉 SW，离线能力丢失').toMatch(/isNativeShell/)
    expect(boot).toMatch(/androidBridge/)
    expect(boot).toMatch(/unregister/)
    expect(boot, '残留的 Cache Storage 也要清掉').toMatch(/caches/)
  })

  it('捕获脚本/样式加载失败，把白屏换成可操作的错误页', () => {
    expect(boot).toMatch(/addEventListener\(\s*'error'/)
    expect(boot, '资源错误要在捕获阶段才拿得到（第三参 true）').toMatch(/\}\s*,\s*true\s*,?\s*\)/)
    expect(boot, '要能识别 SCRIPT 资源失败').toMatch(/SCRIPT/)
    expect(boot, '必须给一个重新打开的出口').toMatch(/location\.reload/)
  })

  it('有超时兜底：脚本压根没跑起来时也要能自救', () => {
    expect(boot).toMatch(/setTimeout/)
    expect(boot).toMatch(/启动超时|打开失败/)
  })

  it('main.ts 挂载成功后会上报，避免占位被误判成失败', () => {
    expect(boot).toMatch(/__bootMounted/)
  })
})

describe('启动兜底 · main.ts 的挂载时机', () => {
  const main = read('src/main.ts')

  it('等首次导航就绪再挂载（守卫在 await 时 router-view 是空的）', () => {
    expect(main, 'main.ts 必须在 router.isReady() 之后挂载，否则守卫期间是白屏').toMatch(
      /router\.isReady\(\)\.then\(/,
    )
  })

  it('有超时兜底：路由永远不就绪时也要把界面挂出来', () => {
    expect(main).toMatch(/setTimeout\(mountApp/)
  })

  it('挂载后通知 boot.js 撤掉超时兜底，并移除占位', () => {
    expect(main).toMatch(/__bootMounted/)
    expect(main, '占位由 main.ts 负责移除').toMatch(/boot-splash/)
  })

  it('Web 端：SW 换新接管后立刻重载（旧页面 + 新 SW 必然 404）', () => {
    expect(main, '缺少 controllerchange 处理：SW 更新后旧页面会请求已被清掉的旧资源').toMatch(
      /controllerchange/,
    )
    expect(main).toMatch(/location\.reload\(\)/)
    // 首次注册时的 controllerchange 只是「SW 接管了本页」，不该白刷一下
    expect(main).toMatch(/controller/)
  })

  it('原生壳不做 SW 更新重载（它压根不注册 SW）', () => {
    expect(main).toMatch(/isNativePlatform/)
  })
})

describe('启动兜底 · App.vue 的空路由占位', () => {
  const app = read('src/App.vue')

  it('首次导航未就绪时自己顶一个占位，而不是渲染空白', () => {
    expect(app, 'App.vue 需要 routeReady 兜底：超时挂载时 router-view 是空的').toMatch(/routeReady/)
    expect(app).toMatch(/app-booting/)
  })

  it('用 matched.length 做初值判断，正常路径上不多闪一帧', () => {
    expect(app).toMatch(/matched\.length/)
  })
})
