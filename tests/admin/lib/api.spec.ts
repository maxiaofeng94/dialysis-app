/**
 * src/admin/lib/api.ts 测试
 *
 * 这层是后台与 admin-api 之间的唯一通道，出错方式只有几种，但都很致命：
 *   · 没带 token / 没配 Supabase 就发请求（白跑一趟还会误导用户）；
 *   · 401 不上报（页面停在原地反复报错，用户不知道该重新登录）；
 *   · 把 body.error 当成成功（写完操作却提示成功）。
 *
 * 用 vi.mock 把 './supabase' 换成可控替身：isConfigured 用 getter 实现，
 * 这样同一个测试文件里既能测「未配置」分支，也能测正常分支。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  configured: true,
  url: 'https://test-project.supabase.co',
  anonKey: 'test-anon-key',
  getSession: vi.fn(),
}))

vi.mock('../../../src/admin/lib/supabase', () => ({
  get isConfigured() {
    return h.configured
  },
  get supabase() {
    return h.configured ? { auth: { getSession: h.getSession } } : null
  },
  get SUPABASE_URL() {
    return h.url
  },
  get SUPABASE_ANON_KEY() {
    return h.anonKey
  },
}))

import {
  AdminApiError,
  api,
  call,
  lastWarning,
  messageOf,
  setForbiddenHandler,
  setUnauthorizedHandler,
} from '../../../src/admin/lib/api'

/** 最小 Response 替身（jsdom 下不依赖真实 Response） */
function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

/** 返回 HTML 而不是 JSON 的响应（例如被网关/网关错误页拦截） */
function htmlResponse(status = 502): Response {
  return {
    ok: false,
    status,
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0')
    },
  } as unknown as Response
}

/** 装上 fetch 替身，返回该替身便于断言 */
function stubFetch(res: Response): ReturnType<typeof vi.fn> {
  const f = vi.fn(async () => res)
  vi.stubGlobal('fetch', f)
  return f as unknown as ReturnType<typeof vi.fn>
}

/** 设置 session（不传 token 表示未登录） */
function withSession(token?: string) {
  h.getSession.mockResolvedValue({
    data: { session: token ? { access_token: token } : null },
    error: null,
  })
}

/** 从一次 call 中取出抛出的错误 */
async function catchError(fn: () => Promise<unknown>): Promise<AdminApiError> {
  const err = await fn().then(
    () => null,
    (e) => e,
  )
  expect(err).toBeInstanceOf(AdminApiError)
  return err as AdminApiError
}

/** 读一次 fetch 的调用参数 */
function fetchArgs(f: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return f.mock.calls[0] as unknown as [string, RequestInit]
}

beforeEach(() => {
  h.configured = true
  h.url = 'https://test-project.supabase.co'
  h.anonKey = 'test-anon-key'
  h.getSession.mockReset()
  withSession('user-token')
  lastWarning.value = null
  setUnauthorizedHandler(() => {})
  setForbiddenHandler(() => {})
})

describe('api · call 的前置校验', () => {
  it('未配置 Supabase → 抛 AdminApiError(500)，文案含「未配置 Supabase」，且不发请求', async () => {
    h.configured = false
    const f = stubFetch(jsonResponse({ data: {} }))

    const err = await catchError(() => call('whoami'))

    expect(err.status).toBe(500)
    expect(err.message).toContain('未配置 Supabase')
    expect(err.message).toContain('VITE_SUPABASE_URL')
    expect(f).not.toHaveBeenCalled()
    expect(h.getSession).not.toHaveBeenCalled()
  })

  it('没有 session（未登录/已过期）→ 抛 401「登录已过期，请重新登录」，且不发请求', async () => {
    withSession(undefined)
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    const f = stubFetch(jsonResponse({ data: {} }))

    const err = await catchError(() => call('stats.overview'))

    expect(err.status).toBe(401)
    expect(err.message).toBe('登录已过期，请重新登录')
    expect(f).not.toHaveBeenCalled()
  })

  it('没有 session 时也触发统一登出回调（否则页面只会停在原地反复报过期）', async () => {
    withSession(undefined)
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    stubFetch(jsonResponse({ data: {} }))

    await catchError(() => call('stats.overview'))

    expect(onUnauthorized).toHaveBeenCalledOnce()
  })
})

describe('api · 正常请求', () => {
  it('POST 到 ${SUPABASE_URL}/functions/v1/admin-api，带 Bearer token 与 apikey', async () => {
    const f = stubFetch(jsonResponse({ ok: true, data: { userId: 'u-1', isAdmin: true } }))

    const data = await call('whoami', { extra: 1 })

    expect(f).toHaveBeenCalledOnce()
    const [url, init] = fetchArgs(f)
    expect(url).toBe('https://test-project.supabase.co/functions/v1/admin-api')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer user-token',
      apikey: 'test-anon-key',
    })
    expect(JSON.parse(String(init.body))).toEqual({ action: 'whoami', payload: { extra: 1 } })
    expect(data).toEqual({ userId: 'u-1', isAdmin: true })
  })

  it('payload 默认空对象；嵌套 payload 原样序列化', async () => {
    const f = stubFetch(jsonResponse({ data: null }))
    await call('audit.list')
    expect(JSON.parse(String(fetchArgs(f)[1].body))).toEqual({ action: 'audit.list', payload: {} })

    const f2 = stubFetch(jsonResponse({ data: null }))
    await call('patient.update', { patientId: 'p-1', patch: { name: 'x' }, list: [1, 2] })
    expect(JSON.parse(String(fetchArgs(f2)[1].body))).toEqual({
      action: 'patient.update',
      payload: { patientId: 'p-1', patch: { name: 'x' }, list: [1, 2] },
    })
  })

  it('只返回 body.data（ok 包装不外泄）', async () => {
    stubFetch(jsonResponse({ ok: true, data: [1, 2, 3] }))
    expect(await call('user.list')).toEqual([1, 2, 3])
  })

  it.each<[string, () => Promise<unknown>, string, Record<string, unknown>]>([
    ['whoami', () => api.whoami(), 'whoami', {}],
    ['stats.overview', () => api.overview(), 'stats.overview', {}],
    ['user.list', () => api.users({ search: 'a', page: 2 }), 'user.list', { search: 'a', page: 2 }],
    ['user.get', () => api.user('u-1'), 'user.get', { userId: 'u-1' }],
    ['patient.list', () => api.patients({ size: 50 }), 'patient.list', { size: 50 }],
    ['patient.get', () => api.patient('p-1'), 'patient.get', { patientId: 'p-1' }],
    ['audit.list', () => api.audit({ page: 3 }), 'audit.list', { page: 3 }],
    ['user.rename', () => api.renameUser('u-1', '张三'), 'user.rename', { userId: 'u-1', name: '张三' }],
    ['user.setBanned', () => api.setBanned('u-1', true), 'user.setBanned', { userId: 'u-1', banned: true }],
    ['user.resetPassword', () => api.resetPassword('u-1', 'newpass'), 'user.resetPassword', { userId: 'u-1', password: 'newpass' }],
    ['user.create', () => api.createUser('13800000000', 'secret1', '新人'), 'user.create', { phone: '13800000000', password: 'secret1', name: '新人' }],
    ['user.delete', () => api.deleteUser('u-1', 'purge', '13800000000'), 'user.delete', { userId: 'u-1', mode: 'purge', confirmPhone: '13800000000' }],
    ['admin.grant', () => api.grantAdmin('u-1', 'note'), 'admin.grant', { userId: 'u-1', note: 'note' }],
    ['admin.revoke', () => api.revokeAdmin('u-1'), 'admin.revoke', { userId: 'u-1' }],
    ['member.add', () => api.addMember('p-1', '13800000000', 'doctor'), 'member.add', { patientId: 'p-1', phone: '13800000000', role: 'doctor' }],
    ['member.setRole', () => api.setMemberRole('p-1', 'u-2', 'viewer'), 'member.setRole', { patientId: 'p-1', userId: 'u-2', role: 'viewer' }],
    ['member.remove', () => api.removeMember('p-1', 'u-2'), 'member.remove', { patientId: 'p-1', userId: 'u-2' }],
    ['patient.update', () => api.updatePatient('p-1', { name: '新名', rinseBackVolume: 0 }), 'patient.update', { patientId: 'p-1', name: '新名', rinseBackVolume: 0 }],
    ['patient.transferOwner', () => api.transferOwner('p-1', 'u-2'), 'patient.transferOwner', { patientId: 'p-1', toUserId: 'u-2' }],
    ['patient.delete', () => api.deletePatient('p-1', '张三'), 'patient.delete', { patientId: 'p-1', confirmName: '张三' }],
  ])('api.%s → action %s 与 payload 正确', async (_name, invoke, action, payload) => {
    const f = stubFetch(jsonResponse({ ok: true, data: null }))
    await invoke()
    expect(JSON.parse(String(fetchArgs(f)[1].body))).toEqual({ action, payload })
  })
})

describe('api · 错误处理', () => {
  it('HTTP 401 → 触发 unauthorized 回调，并抛 AdminApiError(401)', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    stubFetch(jsonResponse({ error: '登录已过期，请重新登录' }, 401))

    const err = await catchError(() => call('whoami'))

    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(err.status).toBe(401)
    expect(err.message).toBe('登录已过期，请重新登录')
  })

  it('HTTP 401 且响应没有 error 字段 → 仍抛 401 并用「请求失败（HTTP 401）」兜底', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    stubFetch(jsonResponse({}, 401))

    const err = await catchError(() => call('whoami'))

    expect(onUnauthorized).toHaveBeenCalledOnce()
    expect(err.status).toBe(401)
    expect(err.message).toBe('请求失败（HTTP 401）')
  })

  it('HTTP 403（无后台权限）→ 抛 403 且不触发登出回调', async () => {
    const onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
    stubFetch(jsonResponse({ error: '无后台权限' }, 403))

    const err = await catchError(() => call('stats.overview'))

    expect(onUnauthorized).not.toHaveBeenCalled()
    expect(err.status).toBe(403)
    expect(err.message).toBe('无后台权限')
  })

  it('HTTP 403 → 触发「复核身份」回调（由 auth.ts 决定是否登出），错误照常抛出', async () => {
    const onForbidden = vi.fn(async () => {})
    setForbiddenHandler(onForbidden)
    stubFetch(jsonResponse({ error: '无后台权限' }, 403))

    const err = await catchError(() => call('stats.overview'))

    expect(onForbidden).toHaveBeenCalledOnce()
    expect(err.status).toBe(403)
  })

  it('HTTP 403 且复核回调自己抛错 → 仍把原始 403 抛给页面', async () => {
    setForbiddenHandler(async () => {
      throw new Error('复核身份失败')
    })
    stubFetch(jsonResponse({ error: '无后台权限' }, 403))

    const err = await catchError(() => call('stats.overview'))

    expect(err.status).toBe(403)
    expect(err.message).toBe('无后台权限')
  })

  it('断网（fetch 抛 TypeError: Failed to fetch）→ 转成中文提示，不泄露英文报错', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', f)

    const err = await catchError(() => call('whoami'))

    expect(err.message).toBe('网络连接失败，请检查网络后重试')
    expect(err.message).not.toContain('Failed to fetch')
    expect(f).toHaveBeenCalledOnce()
  })

  it('取 token 失败抛的 401 不会被断网分支吞掉（仍是「登录已过期」）', async () => {
    withSession(undefined)
    const f = stubFetch(jsonResponse({ data: {} }))

    const err = await catchError(() => call('whoami'))

    expect(err.status).toBe(401)
    expect(err.message).toBe('登录已过期，请重新登录')
    expect(f).not.toHaveBeenCalled()
  })

  it('HTTP 500 → 抛 500 并原样回传服务端错误信息', async () => {
    stubFetch(jsonResponse({ error: '读取 sessions 失败：permission denied' }, 500))
    const err = await catchError(() => call('stats.overview'))
    expect(err.status).toBe(500)
    expect(err.message).toContain('permission denied')
  })

  it('HTTP 200 但 body 里有 error → 仍然抛错（不会被当成成功）', async () => {
    stubFetch(jsonResponse({ error: '参数不正确' }, 200))
    const err = await catchError(() => call('user.rename', { userId: '', name: '' }))
    expect(err.status).toBe(200)
    expect(err.message).toBe('参数不正确')
  })

  it('响应不是 JSON → 不抛解析错误，走「请求失败（HTTP 502）」', async () => {
    stubFetch(htmlResponse(502))
    const err = await catchError(() => call('whoami'))
    expect(err.status).toBe(502)
    expect(err.message).toBe('请求失败（HTTP 502）')
  })

  it('HTTP 204 之类空响应体（解析为 {}）→ 返回 undefined 且不报错', async () => {
    stubFetch(jsonResponse({}, 200))
    await expect(call('whoami')).resolves.toBeUndefined()
    expect(lastWarning.value).toBeNull()
  })

  it('未注册 unauthorized 回调时 401 不会抛二次异常', async () => {
    setUnauthorizedHandler(() => {})
    stubFetch(jsonResponse({ error: '登录已过期，请重新登录' }, 401))
    expect((await catchError(() => call('whoami'))).status).toBe(401)
  })

  it('多次注册回调只有最后一个生效', async () => {
    const first = vi.fn()
    const second = vi.fn()
    setUnauthorizedHandler(first)
    setUnauthorizedHandler(second)
    stubFetch(jsonResponse({ error: 'x' }, 401))
    await catchError(() => call('whoami'))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
  })
})

describe('api · lastWarning（审计日志写入失败等告警）', () => {
  it('body.warning 写进 lastWarning', async () => {
    stubFetch(jsonResponse({ ok: true, data: { userId: 'u-1' }, warning: '操作已执行，但审计日志写入失败：boom' }))

    await call('user.rename', { userId: 'u-1', name: '张三' })

    expect(lastWarning.value).toBe('操作已执行，但审计日志写入失败：boom')
  })

  it('没有 warning 时置为 null（清掉上一次的残留）', async () => {
    lastWarning.value = '上一次的告警'
    stubFetch(jsonResponse({ ok: true, data: null }))
    await call('whoami')
    expect(lastWarning.value).toBeNull()
  })

  it('请求失败时不改动 lastWarning（错误由页面自己提示）', async () => {
    lastWarning.value = '上一条告警'
    stubFetch(jsonResponse({ error: '无后台权限' }, 403))
    await catchError(() => call('stats.overview'))
    expect(lastWarning.value).toBe('上一条告警')
  })
})

describe('api · messageOf', () => {
  it('AdminApiError → 直接给它的 message', () => {
    expect(messageOf(new AdminApiError('无后台权限', 403))).toBe('无后台权限')
  })

  it('其它 Error → 给 message（含 TypeError / 网络错误）', () => {
    expect(messageOf(new Error('Failed to fetch'))).toBe('Failed to fetch')
    expect(messageOf(new TypeError('x is not a function'))).toBe('x is not a function')
  })

  it('非 Error（字符串 / undefined / null / 对象）→ 通用文案「操作失败」', () => {
    expect(messageOf('炸了')).toBe('操作失败')
    expect(messageOf(undefined)).toBe('操作失败')
    expect(messageOf(null)).toBe('操作失败')
    expect(messageOf({ message: '看起来像错误' })).toBe('操作失败')
  })

  it('AdminApiError 的 name 与 status 可被页面区分（401/403 走不同分支）', () => {
    const err = new AdminApiError('无后台权限', 403)
    expect(err.name).toBe('AdminApiError')
    expect(err.status).toBe(403)
    expect(err instanceof Error).toBe(true)
  })
})
