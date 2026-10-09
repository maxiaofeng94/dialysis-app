/**
 * src/stores/auth.ts 单元测试
 *
 * 该模块在**导入时**就读取 `isCloudConfigured`（lib/supabase 的模块级常量），
 * 所以「本地模式」与「云端模式」两套用例都必须 vi.doMock + vi.resetModules() + 动态 import，
 * 才能拿到对应模式下全新初始化的 store（模块级 ref 也一并重置）。
 *
 * cloudCache 与 stores/patient 同样被替换成间谍，用于断言「登出必须清本机残留」。
 */
import { describe, it, expect, vi } from 'vitest'
import { fakeSupabaseModule, makeAuthClient } from '../helpers/cloud'

/** 假 session 里的用户对象（只用到 id / email） */
function makeUser(id: string, phone = '13800000000') {
  return { id, email: `${phone}@phone.local`, user_metadata: { phone } }
}

interface LoadOptions {
  /** 是否配置了云端（决定 isCloudConfigured / supabase 是否为 null） */
  configured?: boolean
  /** auth.getSession() 返回的 session */
  session?: unknown | null
  /** 是否用自带的 signInWithPassword 实现 */
  signInError?: { message: string } | null
}

/** 装载一份全新的 auth store（含可断言的依赖间谍） */
async function loadAuth(opts: LoadOptions = {}) {
  const configured = opts.configured ?? true

  const client = makeAuthClient({
    getSession: vi.fn(async () => ({ data: { session: opts.session ?? null }, error: null })),
    signInWithPassword: vi.fn(async () =>
      opts.signInError ? { data: {}, error: opts.signInError } : { data: {}, error: null },
    ),
  })

  const cacheClear = vi.fn(async () => {})
  const clearCurrentPatient = vi.fn(async () => {})

  vi.doMock('../../src/lib/supabase', () => fakeSupabaseModule({ configure: configured, client }))
  vi.doMock('../../src/lib/cloudCache', () => ({ cacheClear, cacheVersion: { value: 0 } }))
  vi.doMock('../../src/stores/patient', () => ({
    clearCurrentPatient,
    currentPatientId: { value: 'patient-default' },
  }))

  vi.resetModules()
  const mod = await import('../../src/stores/auth')

  return { mod, store: mod.useAuth(), client, cacheClear, clearCurrentPatient }
}

/** 取出 init() 注册的 onAuthStateChange 回调 */
function authCallback(client: ReturnType<typeof makeAuthClient>) {
  const calls = (client.auth.onAuthStateChange as unknown as { mock: { calls: any[][] } }).mock.calls
  return calls[0]?.[0] as (event: string, session: unknown) => void
}

describe('useAuth · 未配置云端（纯本地单机模式）', () => {
  it('init() 直接把 initialized 置 true，user 保持 null，且不碰 supabase', async () => {
    const { store, client } = await loadAuth({ configured: false })
    expect(store.initialized.value).toBe(false)

    await store.init()

    expect(store.initialized.value).toBe(true)
    expect(store.user.value).toBeNull()
    expect(store.isLoggedIn.value).toBe(false)
    expect(client.auth.getSession).not.toHaveBeenCalled()
    expect(client.auth.onAuthStateChange).not.toHaveBeenCalled()
  })

  it('isLoggedIn 是 computed：未配置云端时即使 user 有值也为 false', async () => {
    const { store, mod } = await loadAuth({ configured: false })
    store.user.value = makeUser('u1') as never

    expect(store.isLoggedIn.value).toBe(false)
    // 与模块导出的 ref 是同一个单例
    expect(store.user).toBe(mod.user)
    expect(store.initialized).toBe(mod.initialized)
  })

  it('未配置云端时 logout() 不抛错（supabase 为 null 走可选链），user 置空并清理本机残留', async () => {
    const { store, cacheClear, clearCurrentPatient } = await loadAuth({ configured: false })
    store.user.value = makeUser('u1') as never

    await expect(store.logout()).resolves.toBeUndefined()

    expect(store.user.value).toBeNull()
    expect(cacheClear).toHaveBeenCalledTimes(1)
    expect(clearCurrentPatient).toHaveBeenCalledTimes(1)
  })
})

describe('useAuth · 已配置云端', () => {
  it('有 session：init() 后 user 为会话用户、isLoggedIn 为 true', async () => {
    const user = makeUser('u1')
    const { store, client } = await loadAuth({ session: { user } })

    await store.init()

    expect(client.auth.getSession).toHaveBeenCalledTimes(1)
    expect(store.user.value).toEqual(user)
    expect(store.isLoggedIn.value).toBe(true)
    expect(store.initialized.value).toBe(true)
  })

  it('无 session：user 为 null、isLoggedIn 为 false，但仍注册登录态监听', async () => {
    const { store, client } = await loadAuth({ session: null })

    await store.init()

    expect(store.user.value).toBeNull()
    expect(store.isLoggedIn.value).toBe(false)
    expect(store.initialized.value).toBe(true)
    expect(client.auth.onAuthStateChange).toHaveBeenCalledTimes(1)
    expect(typeof authCallback(client)).toBe('function')
  })

  it('重复调用 init() 只注册一次监听（并发导航不会叠加回调）', async () => {
    const { store, client } = await loadAuth({ session: null })
    // 回归：曾无重入保护，重复调用会反复 onAuthStateChange，回调层层叠加
    await Promise.all([store.init(), store.init(), store.init()])
    await store.init()
    expect(client.auth.onAuthStateChange).toHaveBeenCalledTimes(1)
  })

  it('onAuthStateChange：SIGNED_IN 更新 user，不清缓存', async () => {
    const { store, client, cacheClear } = await loadAuth({ session: null })
    await store.init()
    const cb = authCallback(client)

    cb('SIGNED_IN', { user: makeUser('u9') })

    expect(store.user.value).toMatchObject({ id: 'u9' })
    expect(store.isLoggedIn.value).toBe(true)
    expect(cacheClear).not.toHaveBeenCalled()
  })

  it('onAuthStateChange：TOKEN_REFRESHED 只更新 user，不触发清理', async () => {
    const { store, client, cacheClear, clearCurrentPatient } = await loadAuth({ session: { user: makeUser('u1') } })
    await store.init()
    const cb = authCallback(client)

    cb('TOKEN_REFRESHED', { user: makeUser('u1') })

    expect(store.user.value).toMatchObject({ id: 'u1' })
    expect(cacheClear).not.toHaveBeenCalled()
    expect(clearCurrentPatient).not.toHaveBeenCalled()
  })

  it('onAuthStateChange：SIGNED_OUT 清空 user 并清缓存 + 当前病人（被服务端踢下线也走这里）', async () => {
    const { store, client, cacheClear, clearCurrentPatient } = await loadAuth({ session: { user: makeUser('u1') } })
    await store.init()
    expect(store.user.value).toMatchObject({ id: 'u1' })
    const cb = authCallback(client)

    cb('SIGNED_OUT', null)

    expect(store.user.value).toBeNull()
    expect(store.isLoggedIn.value).toBe(false)
    // clearLocalState() 是 fire-and-forget（void），等微任务跑完
    await vi.waitFor(() => expect(cacheClear).toHaveBeenCalledTimes(1))
    expect(clearCurrentPatient).toHaveBeenCalledTimes(1)
  })
})

describe('useAuth · login', () => {
  it('用「手机号@phone.local」作为伪邮箱调用 signInWithPassword', async () => {
    const { store, client } = await loadAuth({ session: null })

    const res = await store.login('13900000001', 'secret1')

    expect(client.auth.signInWithPassword).toHaveBeenCalledWith({
      email: '13900000001@phone.local',
      password: 'secret1',
    })
    expect(res).toEqual({ ok: true, message: '登录成功' })
  })

  it('登录失败：把 Supabase 的英文报错转成中文文案，ok 为 false', async () => {
    const { store, client } = await loadAuth({ session: null, signInError: { message: 'Invalid login credentials' } })

    const res = await store.login('13900000001', 'wrong')

    // 回归：曾经把 'Invalid login credentials' 这样的英文原文直接弹给用户
    expect(res).toEqual({ ok: false, message: '手机号或密码不正确' })
    expect(client.auth.signInWithPassword).toHaveBeenCalledOnce()
  })

  it('网络类报错也转成中文提示', async () => {
    const { store } = await loadAuth({ session: null, signInError: { message: 'Failed to fetch' } })

    const res = await store.login('13900000001', 'secret1')

    expect(res).toEqual({ ok: false, message: '网络连接失败，请检查网络后重试' })
  })

  it('登录失败时不会顺手写入 user', async () => {
    const { store } = await loadAuth({ session: null, signInError: { message: 'boom' } })
    await store.login('13900000001', 'wrong')
    expect(store.user.value).toBeNull()
  })
})

describe('useAuth · register（走 Edge Function）', () => {
  /** 造一次 fetch 响应 */
  function stubFetch(body: string, status = 200, contentType = 'application/json') {
    const fetchMock = vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } }))
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('POST 到 /functions/v1/register，带 anon key 的 Authorization/apikey 头，body 含手机号密码', async () => {
    const { store } = await loadAuth({ session: null })
    const fetchMock = stubFetch(JSON.stringify({ success: true }))

    const res = await store.register('13800000000', 'secret1', 'turnstile-token')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://test-project.supabase.co/functions/v1/register')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-anon-key',
      apikey: 'test-anon-key',
    })
    expect(JSON.parse(String(init.body))).toEqual({
      phone: '13800000000',
      password: 'secret1',
      turnstileToken: 'turnstile-token',
    })
    expect(res).toEqual({ ok: true, message: '注册成功' })
  })

  it('未做人机验证时 turnstileToken 为 undefined（仍会带在 body 里由服务端忽略）', async () => {
    const { store } = await loadAuth({ session: null })
    const fetchMock = stubFetch(JSON.stringify({ success: true }))

    await store.register('13800000000', 'secret1')

    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.turnstileToken).toBeUndefined()
    expect(body.phone).toBe('13800000000')
  })

  it('服务端返回错误体：ok=false，message 取响应体的 error', async () => {
    const { store } = await loadAuth({ session: null })
    stubFetch(JSON.stringify({ error: '该手机号已注册，请直接登录' }), 400)

    const res = await store.register('13800000000', 'secret1')

    expect(res).toEqual({ ok: false, message: '该手机号已注册，请直接登录' })
  })

  it('响应不是 JSON（网关 502 返回 HTML）→ 兜底失败文案，绝不提示「注册成功」', async () => {
    const { store } = await loadAuth({ session: null })
    stubFetch('<html>502 Bad Gateway</html>', 502, 'text/html')

    const res = await store.register('13800000000', 'secret1')

    // 回归：res.json() 失败后 data 兜底为 {}，message 曾落到默认值「注册成功」，
    // 而 ok=false —— 用户看到「注册成功」却并没有注册上。
    expect(res.ok).toBe(false)
    expect(res.message).toBe('注册失败，请稍后再试')
  })

  it('网络异常不抛出，返回可展示的中文提示', async () => {
    const { store } = await loadAuth({ session: null })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const res = await store.register('13800000000', 'secret1')
    expect(res.ok).toBe(false)
    expect(res.message).toBe('网络连接失败，请检查网络后重试')
  })
})

describe('useAuth · logout', () => {
  it('调用 signOut、user 置空，并清缓存与当前病人', async () => {
    const { store, client, cacheClear, clearCurrentPatient } = await loadAuth({ session: { user: makeUser('u1') } })
    await store.init()

    await store.logout()

    expect(client.auth.signOut).toHaveBeenCalledTimes(1)
    expect(store.user.value).toBeNull()
    expect(store.isLoggedIn.value).toBe(false)
    expect(cacheClear).toHaveBeenCalledTimes(1)
    expect(clearCurrentPatient).toHaveBeenCalledTimes(1)
  })

  it('signOut 返回 error 对象时仍会清空内存状态（不把用户卡在「已登录」）', async () => {
    const { store, client, cacheClear } = await loadAuth({ session: { user: makeUser('u1') } })
    await store.init()
    ;(client.auth.signOut as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({
      error: { message: '网络不可用' },
    })

    await store.logout()

    expect(store.user.value).toBeNull()
    expect(cacheClear).toHaveBeenCalledTimes(1)
  })

  it('signOut 直接 reject 时也不把用户留在「已登录」：本地状态照清', async () => {
    // supabase-js 的 signOut 正常是 resolve({ error })，不会 reject；
    // 这里验证「万一 reject」时 try/finally 仍保证本机状态被清干净
    //（否则共用设备上换账号会先看到上一个账号的数据）。
    const { store, client, cacheClear } = await loadAuth({ session: { user: makeUser('u1') } })
    await store.init()
    ;(client.auth.signOut as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
      new Error('boom'),
    )

    await expect(store.logout()).rejects.toThrow('boom')

    expect(store.user.value).toBeNull()
    expect(cacheClear).toHaveBeenCalledTimes(1)
  })
})
