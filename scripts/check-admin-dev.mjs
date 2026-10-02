/**
 * 后台预览（dev server）资源加载链自检 —— 专治「HTML 返回 200 但页面白屏」。
 *
 * 背景：曾出现 admin/index.html 里的入口脚本解析不到（../src/admin/main.ts 在 root 变化后
 * 指向了不存在的文件），页面白屏，但 curl 首页仍是 200，很容易误判为「服务正常」。
 *
 * 本脚本从首页 HTML 出发，按**浏览器语义**解析相对路径，再沿 import 关系递归请求本地模块，
 * 确认每个都能拿到 JS/模块内容，而不是被 SPA fallback 成 HTML。
 *
 * 用法（需先启动 npm run dev:admin）：
 *   npm run check:admin-dev
 *   ADMIN_DEV_URL=http://127.0.0.1:5174 npm run check:admin-dev
 */
const BASE = (process.env.ADMIN_DEV_URL || 'http://127.0.0.1:5174').replace(/\/$/, '')
const ORIGIN = new URL(BASE).origin
const MAX_URLS = 80

let failed = 0
function record(ok, label, extra = '') {
  if (!ok) failed++
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`)
}

async function get(href) {
  const res = await fetch(href, { redirect: 'follow' })
  const text = await res.text()
  return { status: res.status, type: res.headers.get('content-type') ?? '', text, href: res.url || href }
}

/** 被 SPA fallback 成 HTML 的模块请求：状态码 200 但内容其实不是模块 */
function looksLikeHtml(body, type) {
  return type.includes('text/html') || /^\s*<!doctype html/i.test(body)
}

function shortPath(href) {
  try {
    return new URL(href).pathname
  } catch {
    return href
  }
}

console.log(`\n=== 后台预览资源自检 @ ${BASE} ===\n`)

let home
try {
  home = await get(BASE + '/')
} catch (err) {
  console.log(`❌ 连不上 ${BASE}：${err.message}\n   请先运行 npm run dev:admin`)
  process.exit(1)
}

record(home.status === 200, '首页可访问', `HTTP ${home.status}`)

const rawEntry = (home.text.match(/src="([^"]+\.(?:ts|js|mjs))"/) ?? [])[1]
record(Boolean(rawEntry), '首页里找到入口脚本', rawEntry ?? '没找到 <script src=…>')
if (!rawEntry) process.exit(1)

// 关键：按浏览器语义解析（相对路径以页面 URL 为基准）
const entryUrl = new URL(rawEntry, home.href || BASE + '/')
record(entryUrl.origin === ORIGIN, '入口脚本指向本站', entryUrl.pathname)

const seen = new Set()
const queue = [entryUrl.href]
const problems = []
const checked = []

while (queue.length && seen.size < MAX_URLS) {
  const href = queue.shift()
  if (seen.has(href)) continue
  seen.add(href)

  let r
  try {
    r = await get(href)
  } catch (err) {
    problems.push(`${shortPath(href)} → 请求失败：${err.message}`)
    continue
  }

  const isHtmlFallback = looksLikeHtml(r.text, r.type)
  const ok = r.status === 200 && !isHtmlFallback
  checked.push(`${ok ? '✅' : '❌'} ${shortPath(href)} [${r.status} ${r.type.split(';')[0]}]`)
  if (!ok) {
    problems.push(
      `${shortPath(href)} → HTTP ${r.status}${isHtmlFallback ? '（被当成 HTML 返回，说明模块没解析出来）' : ''}`,
    )
    continue
  }

  // 沿 import / from 继续找本地模块（跳过 vite 内部与依赖预构建）
  if (/\.(ts|vue|js|mjs)$/.test(shortPath(href))) {
    for (const m of r.text.matchAll(/(?:import|from)\s*\(?\s*["']([^"']+)["']/g)) {
      let next
      try {
        next = new URL(m[1], href)
      } catch {
        continue
      }
      if (next.origin !== ORIGIN) continue
      if (next.pathname.startsWith('/@vite/') || next.pathname.startsWith('/node_modules/')) continue
      queue.push(next.href)
    }
  }
}

console.log('\n--- 模块加载明细 ---')
for (const line of checked) console.log('  ' + line)

if (problems.length) {
  console.log('\n--- 问题 ---')
  for (const p of problems) console.log('  ❌ ' + p)
  console.log(`\n=== ❌ 自检失败：${problems.length} 个资源无法加载（页面会白屏）===`)
  process.exit(1)
}
console.log(`\n=== ✅ 资源链正常：共检查 ${checked.length} 个资源，页面可以正常加载 ===`)
