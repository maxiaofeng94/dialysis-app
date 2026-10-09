/**
 * src/admin/lib/auth.ts 测试
 *
 * 登录态是整个后台的门：手机号要映射成伪邮箱（与 App 同一套账号）、
 * 登录后必须立刻确认「是不是管理员」（不是就退登，不能把界面留在半登录状态）、
 * 401 要统一登出并跳登录页（不能原地反复报错）。
 *
 * 这里把 './supabase' 与 './api' 都换成替身：前者控制 session/登录结果，
 * 后者控制 whoami 的返回值与异常，从而把每条分支都逼出来。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const h = vi.hoisted(() => {
  const auth = {
    getSession: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
    onAuthStateChange: vi.fn(),
    updateUser: vi.fn(),
  }
  return {
    configured: true,
    auth,
    whoami: vi.fn(),
    /** auth.ts 通过 setUnauthorizedHandler 注册的回调 */
    unauthorized: null as null | (() => void),
    /** auth.ts 通过 setForbiddenHandler 注册的回调 */
    forbidden: null as null | (() => Promise<void> | void),
  }
})

vi.mock('../../../src/admin/lib/supabase', () => ({
  get isConfigured() {
    return h.configured
  },
  get supabase() {
    return h.configured ? { auth: h.auth } : null
  },
  get SUPABASE_URL() {
    return 'https://test-project.supabase.co'
  },
  get SUPABASE_ANON_KEY() {
    return 'test-anon-key'
  },
}))

vi.mock('../../../src/admin/lib/api', () => ({
  AdminApiError: class AdminApiError extends Error {
    status: number
    constructor(message: string, status: number) {
      super(message)
      this.name = 'AdminApiError'
      this.status = status
    }
  },
  api: { whoami: h.whoami },
  messageOf: (err: unknown) => (err instanceof Error ? err.message : '操作失败'),
  setUnauthorizedHandler: (fn: () => void) => {
    h.unauthorized = fn
  },
  setForbiddenHandler: (fn: () => Promise<void> | void) => {
    h.forbidden = fn
  },
}))

import {
  adminUser,
  consumeSignOutReason,
  initAuth,
  login,
  logout,
  me,
  ready,
  refreshWhoami,
} from '../../../src/admin/lib/auth'

const WHO = { userId: 'u-admin', isAdmin: true, name: '管理员甲', phone: '13800000001' }

/** 设置初始 session（不传 user 表示未登录） */
function withSession(user: Record<string, unknown> | null) {
  h.auth.getSession.mockResolvedValue({ data: { session: user ? { user } : null }, error: null })
}

beforeEach(() => {
  h.configured = true
  h.auth.getSession.mockReset()
  h.auth.signInWithPassword.mockReset()
  h.auth.signOut.mockReset()
  h.auth.onAuthStateChange.mockReset().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  h.whoami.mockReset()
  h.unauthorized = null
  h.forbidden = null
  // 模块级状态是单例：每个用例前手动复位
  adminUser.value = null
  me.value = null
  ready.value = false
  consumeSignOutReason()
})

afterEach(() => {
  window.location.hash = ''
})

describe('auth · login', () => {
  it('手机号映射成伪邮箱：13800000000 → 13800000000@phone.local', async () => {
    h.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u-admin' } }, error: null })
    h.whoami.mockResolvedValue(WHO)

    const res = await login('13800000000', 'secret1')

    expect(h.auth.signInWithPassword).toHaveBeenCalledWith({
      email: '13800000000@phone.local',
      password: 'secret1',
    })
    expect(res).toEqual({ ok: true, message: '登录成功' })
    expect(me.value).toEqual(WHO)
  })

  it('登录成功但没有后台权限 → 退登并返回「该账号没有后台权限」', async () => {
    h.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u-1' } }, error: null })
    h.whoami.mockResolvedValue({ userId: 'u-1', isAdmin: false, name: '张三', phone: '13800000002' })
    adminUser.value = { id: 'u-1' } as never

    const res = await login('13800000002', 'secret1')

    expect(res).toEqual({ ok: false, message: '该账号没有后台权限' })
    expect(h.auth.signOut).toHaveBeenCalledOnce()
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(me.value).toBeNull()
    expect(adminUser.value).toBeNull()
  })

  it('whoami 抛错（例如 401/网络异常）→ 退登并回传错误信息', async () => {
    h.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u-1' } }, error: null })
    h.whoami.mockRejectedValue(new Error('登录已过期，请重新登录'))
    adminUser.value = { id: 'u-1' } as never

    const res = await login('13800000002', 'secret1')

    expect(res).toEqual({ ok: false, message: '登录已过期，请重新登录' })
    expect(h.auth.signOut).toHaveBeenCalledOnce()
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(adminUser.value).toBeNull()
    expect(me.value).toBeNull()
  })

  it('whoami 抛出非 Error → 提示「操作失败」', async () => {
    h.auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'u-1' } }, error: null })
    h.whoami.mockRejectedValue('boom')

    const res = await login('13800000002', 'secret1')

    expect(res).toEqual({ ok: false, message: '操作失败' })
    expect(h.auth.signOut).toHaveBeenCalledOnce()
  })

  it.each([
    ['Invalid login credentials', '手机号或密码不正确'],
    ['invalid login credentials', '手机号或密码不正确'],
    ['Email not confirmed', '账号未确认'],
    ['User is banned', '账号已被禁用，请联系其他管理员'],
    ['User disabled by administrator', '账号已被禁用，请联系其他管理员'],
    ['Email rate limit exceeded', '尝试过于频繁，请稍后再试'],
    ['Too many requests, please try again later', '尝试过于频繁，请稍后再试'],
    ['Something weird happened', 'Something weird happened'],
  ])('登录错误「%s」→ 文案「%s」', async (raw, expected) => {
    h.auth.signInWithPassword.mockResolvedValue({ data: {}, error: { message: raw } })

    const res = await login('13800000000', 'secret1')

    expect(res).toEqual({ ok: false, message: expected })
    expect(h.whoami).not.toHaveBeenCalled() // 登录都没成功，不该去问 whoami
  })

  it('未配置 Supabase → 直接返回提示，不调用 auth', async () => {
    h.configured = false
    const res = await login('13800000000', 'secret1')
    expect(res).toEqual({ ok: false, message: '未配置 Supabase 连接，无法登录' })
    expect(h.auth.signInWithPassword).not.toHaveBeenCalled()
  })
})

describe('auth · initAuth', () => {
  it('未配置 → ready=true，且不注册 401 回调、不读 session', async () => {
    h.configured = false
    await initAuth()

    expect(ready.value).toBe(true)
    expect(h.unauthorized).toBeNull()
    expect(h.auth.getSession).not.toHaveBeenCalled()
    expect(adminUser.value).toBeNull()
  })

  it('已配置但没有 session → ready=true、adminUser/me 为 null，且不调 whoami', async () => {
    withSession(null)
    await initAuth()

    expect(ready.value).toBe(true)
    expect(adminUser.value).toBeNull()
    expect(me.value).toBeNull()
    expect(h.whoami).not.toHaveBeenCalled()
    expect(h.auth.onAuthStateChange).toHaveBeenCalledOnce()
  })

  it('已配置且有 session → 设置 adminUser 并 refreshWhoami', async () => {
    const user = { id: 'u-admin', email: '13800000001@phone.local' }
    withSession(user)
    h.whoami.mockResolvedValue(WHO)

    await initAuth()

    expect(adminUser.value).toEqual(user)
    expect(h.whoami).toHaveBeenCalledOnce()
    expect(me.value).toEqual(WHO)
    expect(ready.value).toBe(true)
  })

  it('已配置且有 session 但 whoami 失败 → me 为 null，不抛出', async () => {
    withSession({ id: 'u-1' })
    h.whoami.mockRejectedValue(new Error('无后台权限'))

    await expect(initAuth()).resolves.toBeUndefined()
    expect(me.value).toBeNull()
    expect(ready.value).toBe(true)
  })

  it('注册了 onAuthStateChange：登出（session 为空）时清空 me 并回到 #/login', async () => {
    withSession({ id: 'u-admin' })
    h.whoami.mockResolvedValue(WHO)
    await initAuth()

    const callback = h.auth.onAuthStateChange.mock.calls[0][0] as (event: string, session: unknown) => void
    me.value = WHO
    window.location.hash = '#/users'
    callback('SIGNED_OUT', null)
    expect(me.value).toBeNull()
    expect(adminUser.value).toBeNull()
    // 会话在别处失效时不能停在只会报错的页面上
    expect(window.location.hash).toBe('#/login')
  })

  it('onAuthStateChange 会话消失但已经在登录页 → 不重复跳转', async () => {
    withSession({ id: 'u-admin' })
    h.whoami.mockResolvedValue(WHO)
    await initAuth()

    const callback = h.auth.onAuthStateChange.mock.calls[0][0] as (event: string, session: unknown) => void
    window.location.hash = '#/login'
    callback('SIGNED_OUT', null)
    expect(window.location.hash).toBe('#/login')
  })

  it('onAuthStateChange 会话消失且带 redirect 查询串（#/login?redirect=…）→ 同样视为已在登录页', async () => {
    withSession({ id: 'u-admin' })
    h.whoami.mockResolvedValue(WHO)
    await initAuth()

    const callback = h.auth.onAuthStateChange.mock.calls[0][0] as (event: string, session: unknown) => void
    window.location.hash = '#/login?redirect=/users'
    callback('SIGNED_OUT', null)
    expect(window.location.hash).toBe('#/login?redirect=/users')
  })

  it('onAuthStateChange 换成另一个账号时更新 adminUser，但不清 me', async () => {
    withSession(null)
    await initAuth()

    const callback = h.auth.onAuthStateChange.mock.calls[0][0] as (event: string, session: unknown) => void
    me.value = WHO
    const nextUser = { id: 'u-2' }
    callback('SIGNED_IN', { user: nextUser })

    expect(adminUser.value).toEqual(nextUser)
    expect(me.value).toEqual(WHO) // 由页面/守卫再决定是否 refreshWhoami
  })

  it('refreshWhoami 单独调用失败时不抛错，只把 me 置空', async () => {
    me.value = WHO
    h.whoami.mockRejectedValue(new Error('boom'))
    await expect(refreshWhoami()).resolves.toBeUndefined()
    expect(me.value).toBeNull()
  })
})

describe('auth · logout 与登出原因', () => {
  it('logout 清空 adminUser/me，并以 scope:local 退登（不吊销手机 App 的登录态）', async () => {
    adminUser.value = { id: 'u-1' } as never
    me.value = WHO

    await logout()

    expect(h.auth.signOut).toHaveBeenCalledOnce()
    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(adminUser.value).toBeNull()
    expect(me.value).toBeNull()
    expect(consumeSignOutReason()).toBeNull() // 没传原因
  })

  it('logout(reason) 的原因只能被取出一次（第二次为 null）', async () => {
    await logout('长时间未操作，已自动退出')

    expect(consumeSignOutReason()).toBe('长时间未操作，已自动退出')
    expect(consumeSignOutReason()).toBeNull()
  })

  it('未配置时 logout 也不报错（supabase 为 null）', async () => {
    h.configured = false
    await expect(logout('随便')).resolves.toBeUndefined()
    expect(consumeSignOutReason()).toBe('随便')
  })
})

describe('auth · 401 统一处理', () => {
  it('已登录时触发 unauthorized → 登出、把原因留下、跳 #/login', async () => {
    withSession({ id: 'u-admin' })
    h.whoami.mockResolvedValue(WHO)
    await initAuth()
    expect(h.unauthorized).toBeTypeOf('function')

    h.unauthorized!()
    await vi.waitFor(() => expect(window.location.hash).toBe('#/login'))

    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(adminUser.value).toBeNull()
    expect(me.value).toBeNull()
    expect(consumeSignOutReason()).toBe('登录状态已失效，请重新登录')
  })

  it('本地已经没有登录态（adminUser 为空）→ 同样跳 #/login（不能停在原地反复报过期）', async () => {
    withSession(null)
    await initAuth()
    adminUser.value = null
    window.location.hash = '#/users'

    h.unauthorized!()
    await vi.waitFor(() => expect(window.location.hash).toBe('#/login'))

    expect(adminUser.value).toBeNull()
    expect(consumeSignOutReason()).toBe('登录状态已失效，请重新登录')
  })
})

describe('auth · 403 复核身份', () => {
  it('initAuth 注册了 403 回调；未配置 Supabase 时不注册任何回调', async () => {
    withSession(null)
    await initAuth()
    expect(h.forbidden).toBeTypeOf('function')

    ready.value = false
    h.configured = false
    h.forbidden = null
    await initAuth()
    expect(h.forbidden).toBeNull()
  })

  it('复核后确认已不是管理员 → 登出（原因「后台权限已被撤销」）并跳 #/login', async () => {
    withSession({ id: 'u-admin' })
    h.whoami.mockResolvedValue(WHO)
    await initAuth()
    adminUser.value = { id: 'u-admin' } as never
    me.value = WHO

    h.whoami.mockResolvedValue({ ...WHO, isAdmin: false })
    window.location.hash = '#/users'
    await h.forbidden!()

    expect(h.auth.signOut).toHaveBeenCalledWith({ scope: 'local' })
    expect(adminUser.value).toBeNull()
    expect(me.value).toBeNull()
    expect(consumeSignOutReason()).toBe('后台权限已被撤销')
    expect(window.location.hash).toBe('#/login')
  })

  it('复核后仍是管理员 → 不登出（单个 action 被拒不等于权限被撤销）', async () => {
    withSession({ id: 'u-admin' })
    h.whoami.mockResolvedValue(WHO)
    await initAuth()
    h.auth.signOut.mockClear()
    window.location.hash = '#/users'

    await h.forbidden!()

    expect(me.value).toEqual(WHO)
    expect(h.auth.signOut).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/users')
    expect(consumeSignOutReason()).toBeNull()
  })

  it('复核请求本身失败（网络异常）→ 不登出，避免把管理员误踢出去', async () => {
    withSession({ id: 'u-admin' })
    h.whoami.mockResolvedValue(WHO)
    await initAuth()
    h.auth.signOut.mockClear()
    window.location.hash = '#/users'

    h.whoami.mockRejectedValue(new Error('网络连接失败，请检查网络后重试'))
    await h.forbidden!()

    expect(h.auth.signOut).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/users')
  })

  it('复核进行中再次收到 403 → 不重复复核（重入保护）', async () => {
    withSession({ id: 'u-admin' })
    h.whoami.mockResolvedValue(WHO)
    await initAuth()
    expect(h.whoami).toHaveBeenCalledTimes(1) // initAuth 那次

    h.whoami.mockResolvedValue({ ...WHO, isAdmin: false })
    await Promise.all([h.forbidden!(), h.forbidden!()])

    expect(h.whoami).toHaveBeenCalledTimes(2) // 只多了一次复核
  })
})
