/**
 * 静态守卫：**每个会读云端数据的页面都必须处理「被踢下线」**。
 *
 * 为什么值得一条守卫：仓储是按登录态分发的（`repo/index.ts` 的 `activeRepository()`），
 * `isLoggedIn` 一变 false，下一次读取就切回**本地仓储** —— 云端账号的本机
 * `dialysis-db` 是空的，页面于是渲染成「请先建立病人档案」「暂无透析记录」，
 * 用户以为档案和记录全丢了；而这时**没有任何导航**，路由守卫也不会执行，
 * 页面会一直停在假象上（真机上表现为「打开 App 数据全没了」）。
 *
 * 第 1 组页面用 `useSessionExpiryRedirect()`；设置页与成员页需要区分「主动退出登录」
 * （它们自己带 `loggingOut` / 跳转顺序），所以保留各自的 watch —— 两者有其一即可。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/** 用公用 composable 的页面 */
const VIA_COMPOSABLE = ['HomeView', 'SessionView', 'ReportView', 'TrendView']

/** 自己实现 watch(isLoggedIn) 的页面（需要 loggingOut / 特定跳转顺序） */
const VIA_OWN_WATCH = ['SettingsView', 'MembersView']

describe('会话失效处理守卫', () => {
  it.each(VIA_COMPOSABLE)('%s 调用了 useSessionExpiryRedirect()', (name) => {
    const src = read(`src/views/${name}.vue`)
    expect(src).toContain("from '../lib/sessionExpiry'")
    expect(src).toMatch(/useSessionExpiryRedirect\(\)/)
  })

  it.each(VIA_OWN_WATCH)('%s 自己监听 isLoggedIn 并跳登录页', (name) => {
    const src = read(`src/views/${name}.vue`)
    expect(src).toMatch(/watch\(\s*isLoggedIn/)
    expect(src).toContain("'/login'")
  })

  it('composable 只在「已登录 → 未登录」时跳转（避免主动登出误报）', () => {
    const src = read('src/lib/sessionExpiry.ts')
    // 必须有 old && !val 这个方向判断
    expect(src).toMatch(/if\s*\(old\s*&&\s*!val\)/)
    expect(src).toContain("router.replace('/login')")
  })
})
